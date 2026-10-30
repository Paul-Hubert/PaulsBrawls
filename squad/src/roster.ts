// The roster (docs/29 §4): bots, their owners and tags. The runtime is its only writer; the mod changes it through
// the control API and keeps a read-only cache. Persisted atomically to roster.json (write a temp file, rename).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Player {
  uuid: string;
  name: string;
}

export interface RosterBot {
  name: string;
  owners: Player[];
  tags: string[];
  createdAt: number;
  createdBy: string;
}

export class RosterError extends Error {
  override name = 'RosterError';
}

export const BOT_NAME = /^[A-Za-z0-9_]{3,16}$/;
export const TAG = /^[a-z0-9_-]{1,24}$/;

export class Roster {
  private readonly bots = new Map<string, RosterBot>();

  constructor(private readonly file: string | null) {
    if (file && existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { bots?: RosterBot[] };
      for (const b of raw.bots ?? []) this.bots.set(b.name, normalize(b));
    }
  }

  all(): RosterBot[] {
    return [...this.bots.values()].map(copy);
  }

  get(name: string): RosterBot | undefined {
    const b = this.find(name);
    return b ? copy(b) : undefined;
  }

  has(name: string): boolean {
    return this.find(name) !== undefined;
  }

  /** The exact roster spelling of a name (bot names are matched case-insensitively, as Minecraft does). */
  canonical(name: string): string | undefined {
    return this.find(name)?.name;
  }

  isOwner(bot: string, uuid: string): boolean {
    return this.find(bot)?.owners.some((o) => o.uuid === uuid) ?? false;
  }

  botsOf(uuid: string): RosterBot[] {
    return this.all().filter((b) => b.owners.some((o) => o.uuid === uuid));
  }

  add(name: string, owners: Player[], by: string, maxBots: number): RosterBot {
    if (!BOT_NAME.test(name)) throw new RosterError(`nom de bot invalide « ${name} » (3 à 16 caractères : lettres, chiffres, _)`);
    if (this.find(name)) throw new RosterError(`le bot ${name} existe déjà`);
    if (this.bots.size >= maxBots) throw new RosterError(`limite de ${maxBots} bots atteinte`);
    if (owners.length === 0) throw new RosterError('il faut au moins un propriétaire');
    const bot: RosterBot = { name, owners: dedupe(owners), tags: [], createdAt: Date.now(), createdBy: by };
    this.bots.set(name, bot);
    this.save();
    return copy(bot);
  }

  remove(name: string): RosterBot {
    const b = this.require(name);
    this.bots.delete(b.name);
    this.save();
    return copy(b);
  }

  addOwners(name: string, players: Player[]): RosterBot {
    const b = this.require(name);
    b.owners = dedupe([...b.owners, ...players]);
    this.save();
    return copy(b);
  }

  removeOwners(name: string, players: Player[]): RosterBot {
    const b = this.require(name);
    const gone = new Set(players.map((p) => p.uuid));
    const left = b.owners.filter((o) => !gone.has(o.uuid));
    if (left.length === 0) throw new RosterError(`${b.name} doit garder au moins un propriétaire`);
    b.owners = left;
    this.save();
    return copy(b);
  }

  /** `changes` like ['+archer', '-melee', 'scout'] (no sign = add). */
  tag(name: string, changes: string[]): RosterBot {
    const b = this.require(name);
    const tags = new Set(b.tags);
    for (const raw of changes) {
      const remove = raw.startsWith('-');
      const t = raw.replace(/^[+-]/, '').toLowerCase();
      if (!TAG.test(t)) throw new RosterError(`étiquette invalide « ${raw} » (a-z, 0-9, _ et -, 24 max)`);
      if (remove) tags.delete(t);
      else tags.add(t);
    }
    b.tags = [...tags].sort();
    this.save();
    return copy(b);
  }

  private find(name: string): RosterBot | undefined {
    const exact = this.bots.get(name);
    if (exact) return exact;
    const lower = name.toLowerCase();
    for (const b of this.bots.values()) if (b.name.toLowerCase() === lower) return b;
    return undefined;
  }

  private require(name: string): RosterBot {
    const b = this.find(name);
    if (!b) throw new RosterError(`bot inconnu : ${name}`);
    return b;
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ bots: [...this.bots.values()] }, null, 2));
    renameSync(tmp, this.file);
  }
}

function dedupe(players: Player[]): Player[] {
  const seen = new Map<string, Player>();
  for (const p of players) seen.set(p.uuid, { uuid: p.uuid, name: p.name });
  return [...seen.values()];
}

function normalize(b: RosterBot): RosterBot {
  return { name: b.name, owners: dedupe(b.owners ?? []), tags: [...(b.tags ?? [])], createdAt: b.createdAt ?? 0, createdBy: b.createdBy ?? '' };
}

function copy(b: RosterBot): RosterBot {
  return { ...b, owners: b.owners.map((o) => ({ ...o })), tags: [...b.tags] };
}
