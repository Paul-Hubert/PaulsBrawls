// The command manifest (docs/29 §5.2): validation, role selectors, and argument parsing from the tokens of
// `/bots order NAME [args]`. A deliberately small JSON-Schema subset: what a chat command line can carry.

import type { Take } from '../leases';

export type ParamType = 'string' | 'integer' | 'number' | 'boolean';

export interface ParamSpec {
  type: ParamType;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
}

export interface Selector {
  tag?: string | string[];
  /** Substring of an item id in the inventory (or held): '_pickaxe' matches any pickaxe. */
  hasItem?: string | string[];
  name?: string | string[];
  not?: Selector;
}

export interface RoleSpec {
  select?: Selector;
  min?: number;
  max?: number;
  take?: Take;
}

export interface Manifest {
  summary: string;
  params: { type: 'object'; properties: Record<string, ParamSpec>; required?: string[] };
  roles: Record<string, Required<Pick<RoleSpec, 'min' | 'max' | 'take'>> & { select: Selector }>;
  duration: 'bounded' | 'until-stopped';
  maxMinutes?: number;
}

export class ManifestError extends Error {
  override name = 'ManifestError';
}

const ROLE_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,23}$/;
const PARAM_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;

/** Validate the `manifest` export. Errors are in English, for the author agent. */
export function validateManifest(raw: unknown): Manifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ManifestError('missing `export const manifest = { summary, params, roles?, duration? }`');
  }
  const m = raw as Record<string, unknown>;
  const known = new Set(['summary', 'params', 'roles', 'duration', 'maxMinutes']);
  for (const k of Object.keys(m)) if (!known.has(k)) throw new ManifestError(`manifest: unknown key "${k}" (allowed: ${[...known].join(', ')})`);
  if (typeof m.summary !== 'string' || !m.summary.trim()) throw new ManifestError('manifest.summary: a short French sentence is required');
  if (m.summary.length > 160) throw new ManifestError('manifest.summary: keep it under 160 characters');

  const params = validateParams(m.params);
  const roles = validateRoles(m.roles);
  const duration = m.duration ?? 'bounded';
  if (duration !== 'bounded' && duration !== 'until-stopped') throw new ManifestError(`manifest.duration: "bounded" or "until-stopped", got ${JSON.stringify(duration)}`);
  let maxMinutes: number | undefined;
  if (m.maxMinutes !== undefined) {
    if (typeof m.maxMinutes !== 'number' || !(m.maxMinutes > 0)) throw new ManifestError('manifest.maxMinutes: a positive number');
    maxMinutes = m.maxMinutes;
  }
  return { summary: m.summary.trim(), params, roles, duration, ...(maxMinutes !== undefined ? { maxMinutes } : {}) };
}

function validateParams(raw: unknown): Manifest['params'] {
  if (raw === undefined) return { type: 'object', properties: {} };
  if (!raw || typeof raw !== 'object') throw new ManifestError('manifest.params: a JSON Schema object `{ type: "object", properties: {…} }`');
  const p = raw as Record<string, unknown>;
  if (p.type !== undefined && p.type !== 'object') throw new ManifestError('manifest.params.type must be "object"');
  const props = (p.properties ?? {}) as Record<string, unknown>;
  if (typeof props !== 'object' || Array.isArray(props)) throw new ManifestError('manifest.params.properties: an object');
  const out: Record<string, ParamSpec> = {};
  for (const [name, specRaw] of Object.entries(props)) {
    if (!PARAM_NAME.test(name)) throw new ManifestError(`manifest.params: bad parameter name "${name}"`);
    const s = specRaw as Record<string, unknown>;
    if (!s || typeof s !== 'object') throw new ManifestError(`manifest.params.${name}: a schema object`);
    if (!['string', 'integer', 'number', 'boolean'].includes(s.type as string)) {
      throw new ManifestError(`manifest.params.${name}.type: one of string, integer, number, boolean (a chat command line carries nothing else)`);
    }
    const spec: ParamSpec = { type: s.type as ParamType };
    if (typeof s.description === 'string') spec.description = s.description;
    if (s.enum !== undefined) {
      if (!Array.isArray(s.enum) || s.enum.length === 0) throw new ManifestError(`manifest.params.${name}.enum: a non-empty array`);
      spec.enum = s.enum;
    }
    if (typeof s.minimum === 'number') spec.minimum = s.minimum;
    if (typeof s.maximum === 'number') spec.maximum = s.maximum;
    if (s.default !== undefined) {
      spec.default = coerce(name, spec, s.default);
    }
    out[name] = spec;
  }
  const required = Array.isArray(p.required) ? (p.required as unknown[]).map(String) : [];
  for (const r of required) if (!out[r]) throw new ManifestError(`manifest.params.required: "${r}" is not a property`);
  return { type: 'object', properties: out, ...(required.length ? { required } : {}) };
}

function validateRoles(raw: unknown): Manifest['roles'] {
  if (raw === undefined) return { all: { select: {}, min: 1, max: Infinity, take: 'free' } };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ManifestError('manifest.roles: an object { roleName: { select, min, max, take } }');
  const out: Manifest['roles'] = {};
  for (const [name, r] of Object.entries(raw as Record<string, unknown>)) {
    if (!ROLE_NAME.test(name)) throw new ManifestError(`manifest.roles: bad role name "${name}"`);
    out[name] = validateRoleSpec(r, `manifest.roles.${name}`);
  }
  if (Object.keys(out).length === 0) throw new ManifestError('manifest.roles: declare at least one role, or leave roles out');
  return out;
}

/** One role: `{ select, min = 0, max = ∞, take = 'free' }` (also what `squad.acquire` takes, plus `as`). */
export function validateRoleSpec(raw: unknown, where: string, extraKeys: string[] = []): Required<Pick<RoleSpec, 'min' | 'max' | 'take'>> & { select: Selector } {
  const role = (raw ?? {}) as Record<string, unknown>;
  if (typeof role !== 'object' || Array.isArray(role)) throw new ManifestError(`${where}: an object { select, min, max, take }`);
  for (const k of Object.keys(role)) {
    if (!['select', 'min', 'max', 'take', ...extraKeys].includes(k)) throw new ManifestError(`${where}: unknown key "${k}"`);
  }
  const min = role.min === undefined ? 0 : role.min;
  const max = role.max === undefined || role.max === null ? Infinity : role.max;
  if (typeof min !== 'number' || min < 0 || !Number.isInteger(min)) throw new ManifestError(`${where}.min: an integer ≥ 0`);
  if (typeof max !== 'number' || max < 1 || (max !== Infinity && !Number.isInteger(max))) throw new ManifestError(`${where}.max: an integer ≥ 1`);
  if (max < min) throw new ManifestError(`${where}: max < min`);
  const take = role.take ?? 'free';
  if (take !== 'free' && take !== 'reclaim') throw new ManifestError(`${where}.take: "free" or "reclaim"`);
  return { select: validateSelector(role.select ?? {}, `${where}.select`), min, max, take };
}

function validateSelector(raw: unknown, where: string): Selector {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ManifestError(`${where}: an object { tag?, hasItem?, name?, not? }`);
  const s = raw as Record<string, unknown>;
  const out: Selector = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'not') out.not = validateSelector(v, `${where}.not`);
    else if (k === 'tag' || k === 'hasItem' || k === 'name') {
      const ok = typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
      if (!ok) throw new ManifestError(`${where}.${k}: a string or an array of strings`);
      out[k] = v as string | string[];
    } else throw new ManifestError(`${where}: unknown key "${k}" (tag, hasItem, name, not)`);
  }
  return out;
}

/** What a selector looks at. */
export interface BotFacts {
  name: string;
  tags: string[];
  /** Item ids in the inventory, held item and armor included. */
  items: string[];
}

const list = (v: string | string[] | undefined): string[] | undefined => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);

/** AND of the given clauses; each array clause is an OR. */
export function matches(sel: Selector, bot: BotFacts): boolean {
  const tags = list(sel.tag);
  if (tags && !tags.some((t) => bot.tags.includes(t.toLowerCase()))) return false;
  const items = list(sel.hasItem);
  if (items && !items.some((i) => bot.items.some((id) => id.includes(i.replace(/^minecraft:/, ''))))) return false;
  const names = list(sel.name);
  if (names && !names.some((n) => n.toLowerCase() === bot.name.toLowerCase())) return false;
  if (sel.not && matches(sel.not, bot)) return false;
  return true;
}

// -- arguments -------------------------------------------------------------------------------------------------

/**
 * Map the tokens of `/bots order NAME …` onto the params: `key=value` by name, the rest positionally in property
 * order. Defaults fill the gaps; `required` without a value, an unknown key or a bad value is an error (French:
 * the player reads it, with the usage line).
 */
export function parseArgs(m: Manifest, tokens: string[]): Record<string, unknown> {
  const props = m.params.properties;
  const names = Object.keys(props);
  const out: Record<string, unknown> = {};
  const positional: string[] = [];
  for (const t of tokens) {
    const eq = /^([a-zA-Z][a-zA-Z0-9_]*)=(.*)$/s.exec(t);
    if (eq && props[eq[1] as string]) out[eq[1] as string] = eq[2];
    else if (eq) throw new ManifestError(`paramètre inconnu « ${eq[1]} »`);
    else positional.push(t);
  }
  let i = 0;
  for (const name of names) {
    if (i >= positional.length) break;
    if (out[name] !== undefined) continue;
    out[name] = positional[i++];
  }
  if (i < positional.length) throw new ManifestError(`trop d'arguments : « ${positional.slice(i).join(' ')} »`);
  for (const name of names) {
    const spec = props[name] as ParamSpec;
    if (out[name] === undefined) {
      if (spec.default !== undefined) out[name] = spec.default;
      else if (m.params.required?.includes(name)) throw new ManifestError(`il manque « ${name} »`);
      continue;
    }
    out[name] = coerce(name, spec, out[name], true);
  }
  return out;
}

function coerce(name: string, spec: ParamSpec, v: unknown, french = false): unknown {
  const bad = (what: string): never => {
    throw new ManifestError(french ? `« ${name} » : ${what}` : `manifest.params.${name}: ${what}`);
  };
  let value: unknown = v;
  switch (spec.type) {
    case 'integer':
    case 'number': {
      const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
      if (!Number.isFinite(n)) bad(french ? `nombre attendu, reçu « ${String(v)} »` : `expected a number, got ${JSON.stringify(v)}`);
      if (spec.type === 'integer' && !Number.isInteger(n)) bad(french ? `entier attendu, reçu « ${String(v)} »` : 'expected an integer');
      if (spec.minimum !== undefined && n < spec.minimum) bad(french ? `minimum ${spec.minimum}` : `below minimum ${spec.minimum}`);
      if (spec.maximum !== undefined && n > spec.maximum) bad(french ? `maximum ${spec.maximum}` : `above maximum ${spec.maximum}`);
      value = n;
      break;
    }
    case 'boolean': {
      const s = String(v).toLowerCase();
      if (typeof v === 'boolean') value = v;
      else if (['true', 'oui', 'yes', '1', 'on'].includes(s)) value = true;
      else if (['false', 'non', 'no', '0', 'off'].includes(s)) value = false;
      else bad(french ? `oui/non attendu, reçu « ${String(v)} »` : 'expected a boolean');
      break;
    }
    case 'string':
      value = String(v);
      break;
  }
  if (spec.enum && !spec.enum.includes(value)) bad(french ? `valeurs possibles : ${spec.enum.join(', ')}` : `not in enum ${JSON.stringify(spec.enum)}`);
  return value;
}

/** `Usage : /bots order defend [radius=16]` from the manifest. */
export function usage(name: string, m: Manifest): string {
  const parts = Object.entries(m.params.properties).map(([p, s]) => {
    const req = m.params.required?.includes(p) && s.default === undefined;
    const hint = s.default !== undefined ? `${p}=${String(s.default)}` : p;
    return req ? `<${hint}>` : `[${hint}]`;
  });
  return `/bots order ${name}${parts.length ? ' ' + parts.join(' ') : ''}`;
}
