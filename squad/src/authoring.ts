// Authoring (docs/29 §8): `/bots create NAME <request>` and `/bots fix NAME [feedback]` open a session with a
// `cmd-…` ticket bound to (player, NAME, mode); the mod runs one turn of the `squad-author` agent with the message
// built here; the agent works only through the tools below (served over MCP, src/http/mcp.ts); the mod closes the
// session when the turn ends and learns whether a version was submitted. `/bots ticket NAME` opens a manual session
// for the player's own Claude Code (longer TTL, several submissions allowed).

import { randomBytes } from 'node:crypto';

import type { Limits } from './config';
import type { Journal } from './journal/journal';
import type { LeaseManager } from './leases';
import type { OrderRunner, PoolView } from './orders/runner';
import type { Player, Roster } from './roster';
import { checkScript, formatDiagnostics, referenceText } from './script/check';
import { usage, type Manifest } from './script/manifest';
import { COMMAND_NAME, type CommandStore } from './store/commands';
import type { OrderReport, Snapshot } from './types';

export type AuthoringMode = 'create' | 'fix' | 'manual';

export interface Session {
  ticket: string;
  player: Player;
  name: string;
  mode: AuthoringMode;
  request: string;
  snap: Snapshot;
  trials: number;
  submitted?: { version: number; summary: string; usage: string };
  expires: number;
}

export class AuthoringError extends Error {
  override name = 'AuthoringError';
}

export interface AuthoringDeps {
  roster: Roster;
  store: CommandStore;
  runner: OrderRunner;
  leases: LeaseManager;
  pool: PoolView;
  journal: Journal;
  limits: Limits;
}

export class Authoring {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly deps: AuthoringDeps) {}

  // -- sessions ----------------------------------------------------------------------------------------------

  /** Open a session (French errors: the player reads them). Returns the ticket and the agent's message. */
  open(req: { mode: AuthoringMode; player: Player; name: string; request: string; snap: Snapshot }): { ticket: string; message: string } {
    this.sweep();
    const name = req.name.toLowerCase();
    if (!COMMAND_NAME.test(name)) throw new AuthoringError(`nom de commande invalide « ${req.name} » (a-z, 0-9 et -, 2 à 32 caractères)`);
    if (this.deps.roster.botsOf(req.player.uuid).length === 0) throw new AuthoringError("tu ne possèdes aucun bot : demande à un admin (/bots spawn)");
    const own = this.deps.store.own(req.player.uuid, name);
    if (req.mode === 'create' && own) throw new AuthoringError(`tu as déjà « ${name} » (v${own.current}) : /bots fix ${name} <ce qui doit changer>`);
    if (req.mode === 'fix' && !own) throw new AuthoringError(`tu n'as pas de commande « ${name} » à corriger (/bots create ${name} …)`);
    if (req.mode !== 'manual') {
      for (const s of this.sessions.values()) {
        if (s.player.uuid === req.player.uuid && s.mode !== 'manual') throw new AuthoringError(`« ${s.name} » est déjà en cours d'écriture`);
      }
    } else {
      // A new manual ticket replaces the player's previous one.
      for (const [t, s] of this.sessions) if (s.player.uuid === req.player.uuid && s.mode === 'manual') this.sessions.delete(t);
    }
    if (req.mode === 'create' && !req.request.trim()) throw new AuthoringError(`dis ce que la commande doit faire : /bots create ${name} <description>`);
    const minutes = req.mode === 'manual' ? this.deps.limits.manualTicketMinutes : this.deps.limits.ticketMinutes;
    const ticket = `cmd-${randomBytes(12).toString('base64url')}`;
    const session: Session = { ticket, player: req.player, name, mode: req.mode, request: req.request.trim(), snap: req.snap, trials: 0, expires: Date.now() + minutes * 60_000 };
    this.sessions.set(ticket, session);
    return { ticket, message: this.message(session) };
  }

  /** The turn ended: the ticket dies; says what was submitted during it. */
  close(ticket: string): Session['submitted'] | null {
    const s = this.sessions.get(ticket);
    this.sessions.delete(ticket);
    return s?.submitted ?? null;
  }

  /** Revoke every session of a player (a manual ticket, `/bots ticket revoke`). */
  revoke(player: string): number {
    let n = 0;
    for (const [t, s] of this.sessions) if (s.player.uuid === player) {
      this.sessions.delete(t);
      n++;
    }
    return n;
  }

  session(ticket: string): Session {
    this.sweep();
    const s = this.sessions.get(String(ticket ?? '').trim());
    if (!s) throw new AuthoringError('unknown or expired ticket: the authoring turn is over (or the ticket was mistyped)');
    return s;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [t, s] of this.sessions) if (s.expires < now) this.sessions.delete(t);
  }

  // -- the agent's first message ---------------------------------------------------------------------------

  message(s: Session): string {
    const lines: string[] = [];
    const header = s.mode === 'create' ? 'Nouvelle commande de bots' : s.mode === 'fix' ? 'Correction d’une commande de bots' : 'Session manuelle';
    lines.push(`[${header} — demandée par ${s.player.name}]`);
    lines.push(`Ticket : ${s.ticket}`);
    lines.push(`Commande : ${s.name}`);
    lines.push(`Bots de ${s.player.name} : ${this.botLine(s.player.uuid)}`);
    lines.push(`Position du joueur : ${fmtSnap(s.snap)}`);
    if (s.mode === 'create') {
      lines.push('', `Demande : ${s.request}`);
    } else if (s.mode === 'fix') {
      const meta = this.deps.store.own(s.player.uuid, s.name);
      if (meta) {
        const source = this.deps.store.source(s.player.uuid, s.name, meta.current);
        const report = this.deps.journal.lastReport(s.player.uuid, s.name);
        lines.push('', `Retour du joueur : ${s.request || '(aucun : corrige ce que le rapport montre)'}`);
        lines.push('', `Code actuel (v${meta.current}, demande d'origine : « ${meta.versions[0]?.request ?? '?'} ») :`, numbered(source));
        lines.push('', report ? `Dernier rapport (ordre #${report.id}, v${report.command.version}) :\n${formatReport(report)}` : "Dernier rapport : aucun (la commande n'a pas encore été lancée).");
      }
    }
    lines.push('', 'Écris la commande avec les outils (get_api_reference d’abord), vérifie-la (check_script), essaie-la (trial_run) si le monde le permet, puis submit_command. Termine par une phrase en français pour le joueur.');
    return lines.join('\n');
  }

  private botLine(uuid: string): string {
    const bots = this.deps.roster.botsOf(uuid);
    if (bots.length === 0) return 'aucun';
    return bots
      .map((b) => {
        const online = !!this.deps.pool.bot(b.name);
        const top = this.deps.leases.top(b.name);
        return `${b.name}${b.tags.length ? ` [${b.tags.join(', ')}]` : ''}${online ? '' : ' (hors ligne)'}${top ? ` (occupé : ordre #${top.orderId})` : ''}`;
      })
      .join(', ');
  }

  // -- the tools (docs/29 §8.3). Errors are English: the agent reads them. ---------------------------------

  apiReference(): string {
    return referenceText();
  }

  context(ticket: string): string {
    const s = this.session(ticket);
    const bots = this.deps.roster.botsOf(s.player.uuid).map((b) => {
      const bot = this.deps.pool.bot(b.name);
      const top = this.deps.leases.top(b.name);
      const inv: Record<string, number> = {};
      for (const it of bot?.inventory?.items?.() ?? []) inv[it.name] = (inv[it.name] ?? 0) + it.count;
      const p = bot?.entity?.position;
      return {
        name: b.name,
        tags: b.tags,
        owners: b.owners.map((o) => o.name),
        online: !!bot,
        busy: top ? { order: top.orderId, ...(this.deps.runner.describe(top.orderId) ?? {}) } : null,
        position: p ? [Math.round(p.x), Math.round(p.y), Math.round(p.z)] : null,
        health: bot?.health ?? null,
        food: bot?.food ?? null,
        held: bot?.heldItem?.name ?? null,
        inventory: inv,
      };
    });
    return JSON.stringify({ player: s.player.name, command: s.name, mode: s.mode, request: s.request, commander: s.snap, bots }, null, 1);
  }

  listCommands(ticket: string): string {
    const s = this.session(ticket);
    const l = this.deps.store.list(s.player.uuid);
    const row = (m: { name: string; author: Player; current: number; versions: Array<{ v: number; summary: string }> }, prefix = '') =>
      `${prefix}${m.name} v${m.current} — ${m.versions.find((v) => v.v === m.current)?.summary ?? ''}`;
    return [
      `Own commands (${l.own.length}):`,
      ...l.own.map((m) => '  ' + row(m)),
      `Shared with ${s.player.name} (${l.shared.length}):`,
      ...l.shared.map((m) => '  ' + row(m, `${m.author.name}:`)),
      `Stock commands, usable by everyone and worked examples to copy from (read_command squad:NAME):`,
      ...l.stock.map((m) => '  ' + row(m, 'squad:')),
    ].join('\n');
  }

  readCommand(ticket: string, ref: string): string {
    const s = this.session(ticket);
    const r = this.deps.store.resolve(s.player.uuid, ref);
    const who = r.stock ? 'squad (stock)' : r.meta.author.name;
    return `// ${who}:${r.meta.name} v${r.version}\n${r.source}`;
  }

  async check(ticket: string, source: string): Promise<{ ok: boolean; text: string }> {
    this.session(ticket);
    const r = await checkScript(source, { maxLines: this.deps.limits.maxScriptLines });
    const s = this.session(ticket);
    const tail = r.manifest ? `\nManifest: "${r.manifest.summary}" — ${usage(s.name, r.manifest)}; roles ${rolesText(r.manifest)}` : '';
    return { ok: r.ok, text: formatDiagnostics(r) + tail };
  }

  async trial(ticket: string, source: string, args: string, seconds?: number): Promise<{ ok: boolean; text: string }> {
    const s = this.session(ticket);
    if (s.trials >= this.deps.limits.maxTrialsPerTurn) {
      return { ok: false, text: `trial limit reached (${this.deps.limits.maxTrialsPerTurn} per turn): rely on check_script and submit` };
    }
    const c = await checkScript(source, { maxLines: this.deps.limits.maxScriptLines, typecheck: false });
    if (!c.ok) return { ok: false, text: 'the draft does not compile:\n' + formatDiagnostics(c) };
    s.trials++;
    const secs = Math.max(5, Math.min(this.deps.limits.trialSeconds, seconds ?? this.deps.limits.trialSeconds));
    const rep = await this.deps.runner.trial({ author: s.player, name: s.name, source, tokens: splitArgs(args), snap: s.snap, seconds: secs });
    if ('error' in rep) return { ok: false, text: `trial not run: ${rep.error}` };
    const ok = rep.status === 'done' || rep.status === 'timeout';
    const note = rep.status === 'timeout' ? `\n(The trial was cut after ${secs} s — normal for a long or until-stopped command.)` : '';
    return { ok, text: `Trial ${s.trials}/${this.deps.limits.maxTrialsPerTurn} on the real server:\n${formatReport(rep)}${note}` };
  }

  async submit(ticket: string, source: string): Promise<{ ok: boolean; text: string }> {
    const s = this.session(ticket);
    if (s.submitted && s.mode !== 'manual') return { ok: false, text: `already submitted v${s.submitted.version} in this turn; one submission per turn` };
    const r = await checkScript(source, { maxLines: this.deps.limits.maxScriptLines });
    if (!r.ok || !r.manifest) return { ok: false, text: 'not submitted:\n' + formatDiagnostics(r) };
    const v = this.deps.store.addVersion(s.player, s.name, source, { request: s.request || (s.mode === 'fix' ? '(fix)' : ''), summary: r.manifest.summary });
    s.submitted = { version: v, summary: r.manifest.summary, usage: usage(s.name, r.manifest) };
    this.deps.runner.emit('state');
    const warnings = r.diagnostics.length ? `\n${formatDiagnostics(r)}` : '';
    return { ok: true, text: `Submitted ${s.name} v${v}. The player orders it with: ${s.submitted.usage}${warnings}` };
  }
}

// -- formatting --------------------------------------------------------------------------------------------------

export function formatReport(r: OrderReport): string {
  const out: string[] = [];
  out.push(`status: ${r.status}${r.endedAt ? ` after ${Math.round((r.endedAt - r.startedAt) / 100) / 10} s` : ''}`);
  if (r.result !== undefined) out.push(`returned: ${r.result}`);
  if (r.error) out.push(`error${r.error.line ? ` at line ${r.error.line}` : ''}: ${r.error.name}: ${r.error.message}`, ...(r.error.stack ? [`stack:\n${r.error.stack}`] : []));
  out.push(`args: ${JSON.stringify(r.args)}`);
  out.push(`bots: ${r.bots.map((b) => `${b.name} (${b.role}${b.from ? `, reclaimed from #${b.from}` : ''})`).join(', ') || 'none'}`);
  const ev = r.events.filter((e) => e.kind !== 'granted' && e.kind !== 'trigger');
  if (ev.length) out.push(`membership: ${ev.map((e) => `${e.kind} ${e.bot}${e.reason ? ` (${e.reason})` : ''}`).join('; ')}`);
  // Clicks of a bound item (docs/29 §5.4): up to 200 per order, so only the count and the last ten.
  const tr = r.events.filter((e) => e.kind === 'trigger');
  if (tr.length) out.push(`triggers (${tr.length}): ${tr.slice(-10).map((e) => `${e.outcome} ${e.trigger ?? 'order'}${e.entity ? ` → ${e.entity}` : e.pos ? ` → ${e.pos.join(',')}` : ''}`).join('; ')}`);
  if (r.failures.length) out.push(`failures (${r.failures.length}):`, ...r.failures.slice(0, 20).map((f) => `  ${f.bot} ${f.op}${f.item !== undefined ? ` ${JSON.stringify(f.item)}` : ''}: ${f.error}`));
  if (r.logs.length) out.push(`log (${r.logs.length} lines):`, ...r.logs.slice(-60).map((l) => '  ' + l));
  const vit = Object.keys(r.vitals.before);
  for (const b of vit) {
    const a = r.vitals.after[b];
    const bf = r.vitals.before[b];
    if (bf && a) out.push(`${b}: ${fmtVitals(bf)} → ${fmtVitals(a)}`);
  }
  return out.join('\n');
}

function fmtVitals(v: OrderReport['vitals']['before'][string]): string {
  const inv = Object.entries(v.inventory).map(([k, n]) => `${n} ${k}`).slice(0, 10).join(', ');
  return `hp ${v.health} food ${v.food} at ${v.position ? v.position.join(',') : '?'} [${inv}]`;
}

function fmtSnap(s: Snapshot): string {
  const p = s.position;
  const look = s.lookBlock ? `, regarde ${s.lookBlock.name} en ${s.lookBlock.x},${s.lookBlock.y},${s.lookBlock.z}` : '';
  const ent = s.lookEntity ? `, vise ${s.lookEntity.username ?? s.lookEntity.name}` : '';
  return `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)} (${s.dimension})${look}${ent}${s.heldItem ? `, tient ${s.heldItem}` : ''}`;
}

function numbered(src: string): string {
  return src
    .split('\n')
    .map((l, i) => `${String(i + 1).padStart(3)}| ${l}`)
    .join('\n');
}

function rolesText(m: Manifest): string {
  return Object.entries(m.roles)
    .map(([n, r]) => `${n} {min ${r.min}, max ${r.max === Infinity ? 'all' : r.max}, take ${r.take}, select ${JSON.stringify(r.select)}}`)
    .join(', ');
}

/** `a b "c d" key=val` → tokens (quotes group words). Same rules as the mod's /bots order parsing. */
export function splitArgs(s: string | undefined): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of String(s ?? '').matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

