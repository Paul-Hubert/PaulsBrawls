// SquadService: the runtime's state and the operations the mod calls (docs/29 §9, §10). Every answer is
// `{ ok, text }` where `text` is the French chat line(s) the mod shows as is, so the mod stays a thin front.
// Permission rules live here too (owner of a bot, author of a command); the mod only says who is asking and
// whether they are an admin.

import type { Limits } from './config';
import type { BotPool } from './bots/pool';
import { Authoring, type AuthoringMode } from './authoring';
import type { Journal } from './journal/journal';
import type { LeaseManager } from './leases';
import type { OrderRunner, OrderRequest, StartResult, TriggerRequest, TriggerResult } from './orders/runner';
import type { Player, Roster } from './roster';
import type { CommandStore, Resolved } from './store/commands';
import { checkScript } from './script/check';
import { parseArgs, usage } from './script/manifest';
import type { Notice, Snapshot } from './types';
import { errorMessage } from './api/errors';
import type { ClaimRegistry } from './orders/claims';
import type { Metrics, Vitals } from './vitals/metrics';

export interface Answer {
  ok: boolean;
  text: string;
  click?: Notice['click'];
  [extra: string]: unknown;
}

export interface ServiceDeps {
  roster: Roster;
  pool: BotPool;
  leases: LeaseManager;
  claims: ClaimRegistry;
  store: CommandStore;
  journal: Journal;
  runner: OrderRunner;
  limits: Limits;
  /** The vitals sampler (main.ts); absent in tests that build a service without one. */
  vitals?: Vitals;
}

const ok = (text: string, extra: Record<string, unknown> = {}): Answer => ({ ok: true, text, ...extra });
const no = (text: string, extra: Record<string, unknown> = {}): Answer => ({ ok: false, text, ...extra });

export class SquadService {
  readonly authoring: Authoring;

  constructor(readonly deps: ServiceDeps) {
    this.authoring = new Authoring({ ...deps, pool: deps.pool });
  }

  // -- state for the mod's cache (tab completion, the join gate) ------------------------------------------------

  state(): Record<string, unknown> {
    const { roster, pool, leases, runner, store } = this.deps;
    const bots = roster.all().map((b) => {
      const top = leases.top(b.name);
      const d = top ? runner.describe(top.orderId) : undefined;
      return {
        name: b.name,
        owners: b.owners,
        tags: b.tags,
        status: pool.status(b.name),
        ...(top ? { order: { id: top.orderId, role: top.role, ...(d ?? {}) } } : {}),
      };
    });
    const commands = store.all().map((m) => ({ name: m.name, author: m.author, shares: m.shares.map((s) => s.uuid) }));
    return {
      bots,
      commands,
      stock: store.list('').stock.map((m) => m.name),
      orders: runner.running().map((o) => ({ id: o.id, command: o.command.name, commander: o.commander, bots: o.memberNames(), trial: o.trial })),
    };
  }

  // -- vitals (docs/32 C) ---------------------------------------------------------------------------------------

  /** `/bots status`: the last 10 s window of the event loop, the process and every bot. Anyone may ask. */
  metrics(): Metrics | Answer {
    return this.deps.vitals ? this.deps.vitals.metrics() : no('[Bots] Les mesures du runtime ne sont pas disponibles.');
  }

  // -- bots ---------------------------------------------------------------------------------------------------

  spawn(by: Player, admin: boolean, name: string, owners: Player[]): Answer {
    if (!admin) return no('[Bots] Seul un admin peut créer des bots.');
    try {
      const b = this.deps.roster.add(name, owners, by.name, this.deps.limits.maxBots);
      this.deps.pool.add(b.name);
      this.deps.runner.emit('state');
      return ok(`[Bots] ${b.name} arrive, propriétaire${b.owners.length > 1 ? 's' : ''} : ${b.owners.map((o) => o.name).join(', ')}.`, { bot: b });
    } catch (e) {
      return no(`[Bots] ${errorMessage(e)}`);
    }
  }

  async despawn(by: Player, admin: boolean, name: string): Promise<Answer> {
    if (!admin) return no('[Bots] Seul un admin peut retirer des bots.');
    const canonical = this.deps.roster.canonical(name);
    if (!canonical) return no(`[Bots] Bot inconnu : ${name}`);
    await this.deps.runner.botGone(canonical, 'despawned');
    this.deps.pool.remove(canonical);
    const b = this.deps.roster.remove(canonical);
    this.deps.runner.emit('state');
    return ok(`[Bots] ${b.name} est parti.`, { bot: b });
  }

  owners(by: Player, admin: boolean, name: string, add: Player[], remove: Player[]): Answer {
    if (!admin) return no('[Bots] Seul un admin peut changer les propriétaires.');
    try {
      let b = this.deps.roster.get(name);
      if (!b) return no(`[Bots] Bot inconnu : ${name}`);
      if (add.length) b = this.deps.roster.addOwners(b.name, add);
      if (remove.length) b = this.deps.roster.removeOwners(b.name, remove);
      this.deps.runner.emit('state');
      return ok(`[Bots] ${b.name} : ${b.owners.map((o) => o.name).join(', ')}.`);
    } catch (e) {
      return no(`[Bots] ${errorMessage(e)}`);
    }
  }

  tag(by: Player, admin: boolean, name: string, changes: string[]): Answer {
    const b = this.deps.roster.get(name);
    if (!b) return no(`[Bots] Bot inconnu : ${name}`);
    if (!admin && !this.deps.roster.isOwner(b.name, by.uuid)) return no(`[Bots] ${b.name} n'est pas à toi.`);
    try {
      const t = this.deps.roster.tag(b.name, changes);
      this.deps.runner.emit('state');
      return ok(`[Bots] ${t.name} : ${t.tags.length ? t.tags.join(', ') : 'aucune étiquette'}.`);
    } catch (e) {
      return no(`[Bots] ${errorMessage(e)}`);
    }
  }

  /** `/bots list`: the player's bots (an admin with `all`: every bot). */
  list(by: Player, all: boolean): Answer {
    const bots = all ? this.deps.roster.all() : this.deps.roster.botsOf(by.uuid);
    if (bots.length === 0) return ok(all ? '[Bots] Aucun bot.' : "[Bots] Tu n'as aucun bot.");
    const lines = bots.map((b) => {
      const status = this.deps.pool.status(b.name);
      const bot = this.deps.pool.bot(b.name);
      const top = this.deps.leases.top(b.name);
      const d = top ? this.deps.runner.describe(top.orderId) : undefined;
      const st = status === 'online' ? (top ? `« ${d?.command ?? '?'} » #${top.orderId} (${d?.commander ?? '?'}, ${top.role})` : 'libre') : status === 'connecting' ? 'connexion…' : `hors ligne${this.deps.pool.lastReason(b.name) ? ` (${this.deps.pool.lastReason(b.name)})` : ''}`;
      const hp = bot ? ` ❤${Math.round(bot.health ?? 0)}` : '';
      return ` • ${b.name}${hp} — ${st}${b.tags.length ? ` [${b.tags.join(', ')}]` : ''}${all || b.owners.length > 1 ? ` — ${b.owners.map((o) => o.name).join(', ')}` : ''}`;
    });
    return ok(['[Bots] ' + (all ? 'Tous les bots :' : 'Tes bots :'), ...lines].join('\n'));
  }

  // -- orders -------------------------------------------------------------------------------------------------

  order(req: OrderRequest): Promise<StartResult> {
    return this.deps.runner.start(req);
  }

  /** A bound item was used (§5.4): deliver to the player's running order of that command, else start it. */
  trigger(req: TriggerRequest): Promise<TriggerResult> {
    return this.deps.runner.trigger(req);
  }

  /**
   * `/bots orders bind`: may this player order that command with these args and @filters? The same rules as
   * `/bots order` (the command resolves for them, the args parse against its manifest, the filters name their bots),
   * without owning a bot: a captain may bind items to hand out. `command` in the answer is what the item stores:
   * the stock name for a stock command, else `author:name`, so a given item still means the binder's command.
   */
  async checkOrder(by: Player, command: string, tokens: string[], filters: string[]): Promise<Answer> {
    const owned = this.deps.roster.botsOf(by.uuid);
    for (const f of filters) {
      if (!owned.some((b) => b.name.toLowerCase() === f.toLowerCase())) return no(`[Bots] ${f} n'est pas un de tes bots.`);
    }
    let r: Resolved;
    try {
      r = this.deps.store.resolve(by.uuid, command);
    } catch (e) {
      return no(`[Bots] ${errorMessage(e)}`);
    }
    const name = r.meta.name;
    const c = await checkScript(r.source, { typecheck: false });
    if (!c.manifest) {
      const why = c.diagnostics.find((d) => d.severity === 'error')?.message ?? 'manifeste invalide';
      return no(`[Bots] « ${name} » v${r.version} ne se charge pas : ${why.split('\n')[0]}`);
    }
    try {
      parseArgs(c.manifest, tokens);
    } catch (e) {
      return no(`[Bots] ${errorMessage(e)}. Usage : ${usage(name, c.manifest)}`);
    }
    const canonical = r.stock ? name : `${r.meta.author.name}:${name}`;
    return ok(`[Bots] Ordre « ${canonical} » : ${c.manifest.summary}`, { command: canonical, summary: c.manifest.summary });
  }

  async stop(by: Player, admin: boolean, target: string): Promise<Answer> {
    return ok(await this.deps.runner.stop(by, admin, target));
  }

  orders(by: Player, admin: boolean): Answer {
    const mine = this.deps.runner.running().filter((o) => !o.trial && (admin || o.commander.uuid === by.uuid || o.memberNames().some((n) => this.deps.roster.isOwner(n, by.uuid))));
    if (mine.length === 0) return ok('[Bots] Aucun ordre en cours.');
    const lines = mine.map((o) => {
      const mins = Math.round((Date.now() - o.report.startedAt) / 60000);
      const bots = o.memberNames().map((n) => `${n} (${o.roleOf(n)})`).join(', ') || 'aucun bot';
      return ` • #${o.id} « ${o.command.name} » de ${o.commander.name}, ${mins} min — ${bots}`;
    });
    return ok(['[Bots] Ordres en cours :', ...lines].join('\n'));
  }

  // -- authoring ------------------------------------------------------------------------------------------------

  openAuthoring(mode: AuthoringMode, by: Player, name: string, request: string, snap: Snapshot): Answer {
    try {
      const r = this.authoring.open({ mode, player: by, name, request, snap });
      return ok('', r);
    } catch (e) {
      return no(`[Bots] ${errorMessage(e)}`);
    }
  }

  closeAuthoring(ticket: string): Answer {
    const s = this.authoring.close(ticket);
    return ok('', { submitted: s });
  }

  revokeTickets(by: Player): Answer {
    const n = this.authoring.revoke(by.uuid);
    return ok(n ? `[Bots] ${n} ticket(s) révoqué(s).` : '[Bots] Aucun ticket actif.');
  }

  // -- commands -------------------------------------------------------------------------------------------------

  commands(by: Player): Answer {
    const l = this.deps.store.list(by.uuid);
    const row = (prefix: string, m: { name: string; current: number; versions: Array<{ v: number; summary: string }> }) =>
      ` • ${prefix}${m.name} — ${m.versions.find((v) => v.v === m.current)?.summary ?? ''}`;
    const lines = ['[Bots] Tes commandes :'];
    lines.push(...(l.own.length ? l.own.map((m) => row('', m) + ` (v${m.current}${m.shares.length ? `, partagée avec ${m.shares.map((s) => s.name).join(', ')}` : ''})`) : [' (aucune — /bots create NOM <description>)']));
    if (l.shared.length) lines.push('Partagées avec toi :', ...l.shared.map((m) => row(`${m.author.name}:`, m)));
    lines.push('De base :', ...l.stock.map((m) => row('', m)));
    return ok(lines.join('\n'));
  }

  async show(by: Player, ref: string): Promise<Answer> {
    try {
      const r = this.deps.store.resolve(by.uuid, ref);
      const c = await checkScript(r.source, { typecheck: false });
      const m = c.manifest;
      const lines = [`[Bots] « ${r.meta.name} » v${r.version} de ${r.stock ? 'squad (de base)' : r.meta.author.name}${m ? ` — ${m.summary}` : ''}`];
      if (m) {
        lines.push(`Usage : ${usage(r.meta.name, m)}`);
        for (const [p, s] of Object.entries(m.params.properties)) lines.push(`  ${p} : ${s.type}${s.default !== undefined ? ` (défaut ${String(s.default)})` : ''}${s.description ? ` — ${s.description}` : ''}`);
        const roles = Object.entries(m.roles).map(([n, ro]) => `${n} (${ro.take === 'reclaim' ? 'réquisitionne' : 'bots libres'}${ro.min ? `, min ${ro.min}` : ''})`);
        lines.push(`Rôles : ${roles.join(', ')} — ${m.duration === 'until-stopped' ? "jusqu'à /bots stop" : 'ponctuelle'}`);
      }
      if (!r.stock && r.meta.author.uuid === by.uuid) {
        lines.push(`Versions : ${r.meta.versions.map((v) => `v${v.v}`).join(', ')}${r.meta.shares.length ? ` — partagée avec ${r.meta.shares.map((s) => s.name).join(', ')}` : ''}`);
      }
      return ok(lines.join('\n'));
    } catch (e) {
      return no(`[Bots] ${errorMessage(e)}`);
    }
  }

  share(by: Player, name: string, players: Player[], remove: boolean): Answer {
    try {
      const m = remove ? this.deps.store.unshare(by.uuid, name, players) : this.deps.store.share(by.uuid, name, players);
      this.deps.runner.emit('state');
      const names = players.map((p) => p.name).join(', ');
      return ok(remove
        ? `[Bots] « ${m.name} » n'est plus partagée avec ${names}.`
        : `[Bots] « ${m.name} » partagée avec ${names}. Ils l'utilisent avec /bots order ${m.name} (ou ${by.name}:${m.name}).`, { notify: remove ? [] : players.map((p) => p.uuid), notifyText: `[Bots] ${by.name} t'a partagé « ${m.name} » : /bots order ${m.name}` });
    } catch (e) {
      return no(`[Bots] ${errorMessage(e)}`);
    }
  }

  delete(by: Player, name: string): Answer {
    try {
      const m = this.deps.store.delete(by.uuid, name);
      this.deps.runner.emit('state');
      return ok(`[Bots] « ${m.name} » supprimée${m.shares.length ? ` (aussi pour ${m.shares.map((s) => s.name).join(', ')})` : ''}.`);
    } catch (e) {
      return no(`[Bots] ${errorMessage(e)}`);
    }
  }

  revert(by: Player, name: string, version: number): Answer {
    try {
      const m = this.deps.store.revert(by.uuid, name, version);
      this.deps.runner.emit('state');
      return ok(`[Bots] « ${m.name} » revient à la v${m.current}.`);
    } catch (e) {
      return no(`[Bots] ${errorMessage(e)}`);
    }
  }
}
