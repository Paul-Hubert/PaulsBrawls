// Standing orders (docs/45 §1): rules on one squad that the runtime fires without the model, `when TRIGGER → do
// ACTION`, so the army reacts in ticks instead of model turns. A closed set of triggers (one row each in TRIGGERS) and
// the General's own actions (the offered orders, advance, reinforce). This file is pure: the rules, their defaults per
// kit, their text, and which one is due given what the sampler measured; Generals (general.ts) fires them through the
// same start() as the model's orders (one writer of a squad's order).

export const TRIGGERS = {
  /** A cluster (new to this rule) within `value` blocks of the squad's centre. */
  contact: { value: 48, min: 4, max: 128, edge: true, free: true, text: (v: number) => `contact within ${v}` },
  /** A cluster within `value` closing on the squad at ≥ 1 b/s (once per cluster). */
  approach: { value: 64, min: 4, max: 128, edge: true, free: true, text: (v: number) => `enemy approaching within ${v}` },
  /** The squad's mean health below `value` % (once per crossing; armed again 10 points above). */
  hp: { value: 40, min: 5, max: 95, edge: true, free: false, text: (v: number) => `health below ${v}%` },
  /** `value` deaths in the squad since the rule last fired (or was set). */
  losses: { value: 1, min: 1, max: 50, edge: true, free: false, text: (v: number) => `${v} loss${v === 1 ? '' : 'es'}` },
  /** No running order and no advance for `value` seconds. */
  idle: { value: 8, min: 2, max: 600, edge: false, free: true, text: (v: number) => `idle ${v}s` },
  /** Its order ended by itself (done or failed; not one you stopped or replaced). */
  ended: { value: 0, min: 0, max: 0, edge: true, free: false, text: () => 'order ended' },
} as const;
export type TriggerKind = keyof typeof TRIGGERS;
export const TRIGGER_KINDS = Object.keys(TRIGGERS) as TriggerKind[];

/** What a rule may do: an offered order, or the General's own moves. */
export const RULE_ACTIONS = ['raid', 'attack', 'line', 'advance', 'reinforce'] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

export interface RuleAt {
  /** "rally", "here", "back N" (N blocks from the enemy, away from it), or any position the order tool takes. */
  pos?: string;
  /** "trigger" (the cluster that fired it), "nearest" (the nearest cluster in sight), or any target the order takes. */
  target?: string;
  facing?: string;
}

export interface Rule {
  when: TriggerKind;
  value: number;
  do: RuleAction;
  args?: string;
  at?: RuleAt;
  /** reinforce: how many. */
  n?: number;
  /** Seconds before it may fire again. */
  cooldown: number;
}

export const DEFAULT_COOLDOWN = 10;
/** A rule does not fire within this long of the model's own order to the squad (the model wins). */
export const RESPECT_MS = 5_000;

/** A rule as the tools give it (`value` and `cooldown_s` optional), checked; throws with an English reason. */
export function checkRule(r: { when: string; value?: number; do: string; args?: string; at?: RuleAt; n?: number; cooldown_s?: number }): Rule {
  const t = TRIGGERS[r.when as TriggerKind];
  if (!t) throw new Error(`unknown trigger "${r.when}" (${TRIGGER_KINDS.join(', ')})`);
  if (!(RULE_ACTIONS as readonly string[]).includes(r.do)) throw new Error(`unknown action "${r.do}" (${RULE_ACTIONS.join(', ')})`);
  const value = r.value ?? t.value;
  if (!Number.isFinite(value) || value < t.min || value > t.max) throw new Error(`${r.when}: value ${value} out of ${t.min}..${t.max}`);
  const cooldown = r.cooldown_s ?? DEFAULT_COOLDOWN;
  if (!Number.isFinite(cooldown) || cooldown < 2 || cooldown > 600) throw new Error(`cooldown_s ${cooldown} out of 2..600`);
  const at = r.at && Object.keys(r.at).length ? { ...r.at } : undefined;
  if ((r.do === 'attack' || r.do === 'raid') && !at?.target && !at?.pos) throw new Error(`${r.do} needs at.target ("trigger", "nearest", a cluster) or at.pos`);
  return { when: r.when as TriggerKind, value, do: r.do as RuleAction, ...(r.args ? { args: r.args } : {}), ...(at ? { at } : {}), ...(r.do === 'reinforce' ? { n: Math.max(1, Math.min(50, Math.round(r.n ?? 1))) } : {}), cooldown };
}

/** One rule in one line: "hp<40 → line @back 24". */
export function ruleText(r: Rule): string {
  const at = r.at ? [r.at.target ? `on ${r.at.target}` : '', r.at.pos ? `@${r.at.pos}` : '', r.at.facing ? `facing ${r.at.facing}` : ''].filter(Boolean).join(' ') : '';
  const what = r.do === 'reinforce' ? `reinforce ${r.n ?? 1}` : r.do;
  return `${TRIGGERS[r.when].text(r.value)} → ${what}${r.args ? ` ${r.args}` : ''}${at ? ` ${at}` : ''}${r.cooldown !== DEFAULT_COOLDOWN ? ` (cooldown ${r.cooldown}s)` : ''}`;
}

/**
 * The rules a squad gets at its first spawn, by kit (docs/45 §1): the mobile kits always have an order other than
 * `line`; foot squads form a line facing the enemy when they stand idle with an enemy in sight.
 */
export function defaultRules(kit: string): Rule[] {
  const r = (x: Parameters<typeof checkRule>[0]): Rule => checkRule(x);
  switch (kit) {
    case 'horseman':
      return [
        r({ when: 'hp', value: 40, do: 'line', at: { pos: 'back 24' } }),
        r({ when: 'contact', value: 48, do: 'attack', at: { target: 'trigger' } }),
        r({ when: 'approach', value: 64, do: 'attack', at: { target: 'trigger' } }),
        r({ when: 'ended', do: 'attack', at: { target: 'nearest' } }),
      ];
    case 'horsearcher':
      return [
        r({ when: 'hp', value: 50, do: 'line', args: 'range=120', at: { pos: 'back 32' } }),
        r({ when: 'contact', value: 64, do: 'raid', args: 'radius=40 quiet=10', at: { target: 'trigger' } }),
        r({ when: 'ended', do: 'raid', args: 'radius=40 quiet=10', at: { target: 'nearest' } }),
      ];
    case 'archer':
    case 'guard':
    case 'spearman':
      return [r({ when: 'idle', value: 8, do: 'line', at: { pos: 'here', target: 'nearest' } })];
    default:
      return [];
  }
}

/** What the sampler measured for one squad, for its rules (one sample). */
export interface SquadView {
  now: number;
  /** Visible clusters: id, distance from the squad's centre, closing speed (b/s, ≤ 0 when not closing). */
  clusters: Array<{ id: string; d: number; closing: number }>;
  /** Mean health %, or null with nobody online. */
  hp: number | null;
  /** Deaths so far in the squad (a running count). */
  deaths: number;
  /** Since when it has had no running order and no advance (undefined: busy). */
  idleSince?: number;
  /** Its order is "free" for contact/approach/idle rules: none, an advance leg, or a `line` (a hold). */
  free: boolean;
  /** When its last order ended by itself (done/failed). */
  endedAt?: number;
  /** When the model last ordered or stopped it. */
  modelAt?: number;
}

/** A rule's memory between samples (edges, cooldowns). */
export interface RuleState {
  firedAt: number;
  /** contact/approach: clusters it already fired for. */
  seen: Set<string>;
  /** hp: armed (above the threshold + 10 since it last fired). */
  armed: boolean;
  /** losses: the death count it counts from. */
  deathsAt: number;
  /** When the rule was set: an order that ended before does not fire `ended`. */
  since: number;
}

export function freshState(deaths: number, now: number): RuleState {
  return { firedAt: 0, seen: new Set(), armed: true, deathsAt: deaths, since: now };
}

/**
 * The first rule due now (list order), with the cluster that fired it; updates the edges it consumes. Null: none.
 * Rules wait RESPECT_MS after the model's own order, and their cooldowns.
 */
export function due(rules: Rule[], states: RuleState[], v: SquadView): { i: number; cluster?: string } | null {
  // Re-arm the hp edges first (whether or not anything fires now).
  rules.forEach((r, i) => {
    if (r.when === 'hp' && v.hp !== null && v.hp >= r.value + 10) states[i]!.armed = true;
  });
  if (v.modelAt !== undefined && v.now - v.modelAt < RESPECT_MS) return null;
  for (const [i, r] of rules.entries()) {
    const st = states[i]!;
    if (v.now - st.firedAt < r.cooldown * 1000) continue;
    if (TRIGGERS[r.when].free && !v.free) continue;
    switch (r.when) {
      case 'contact':
      case 'approach': {
        const c = v.clusters
          .filter((c) => c.d <= r.value && !st.seen.has(c.id) && (r.when === 'contact' || c.closing >= 1))
          .sort((a, b) => a.d - b.d)[0];
        if (c) {
          st.seen.add(c.id);
          return { i, cluster: c.id };
        }
        break;
      }
      case 'hp':
        if (v.hp !== null && v.hp < r.value && st.armed) {
          st.armed = false;
          return { i };
        }
        break;
      case 'losses':
        if (v.deaths - st.deathsAt >= r.value) {
          st.deathsAt = v.deaths;
          return { i };
        }
        break;
      case 'idle':
        if (v.idleSince !== undefined && v.now - v.idleSince >= r.value * 1000) return { i };
        break;
      case 'ended':
        if (v.endedAt !== undefined && v.endedAt > Math.max(st.firedAt, st.since)) return { i };
        break;
    }
  }
  return null;
}
