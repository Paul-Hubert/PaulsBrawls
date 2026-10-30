// The command store (docs/29 §11): `commands/<authorUuid>/<name>/meta.json` + `v<N>.mjs`, versions append-only and
// kept forever. Commands are private to their author; `share` grants others the right to order them (always the
// current version). Stock commands ship with the runtime (src/stock/*.mjs), belong to the pseudo-author `squad`
// and are usable by everyone. Resolution for a player: own → shared with them → stock; `owner:NAME` picks one.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Player } from '../roster';

export const STOCK_AUTHOR: Player = { uuid: '00000000-0000-0000-0000-000000000000', name: 'squad' };
export const COMMAND_NAME = /^[a-z0-9][a-z0-9-]{1,31}$/;

export interface VersionInfo {
  v: number;
  at: number;
  /** The player's request (or fix feedback) that produced it. */
  request: string;
  summary: string;
}

export interface CommandMeta {
  name: string;
  author: Player;
  current: number;
  versions: VersionInfo[];
  shares: Player[];
  createdAt: number;
}

export interface Resolved {
  meta: CommandMeta;
  version: number;
  source: string;
  stock: boolean;
}

export class StoreError extends Error {
  override name = 'StoreError';
}

export class CommandStore {
  private readonly metas = new Map<string, CommandMeta>(); // `${uuid}/${name}`
  private readonly stock = new Map<string, { meta: CommandMeta; source: string }>();
  /** Sources when there is no data dir (tests). */
  private readonly memory = new Map<string, string>();

  constructor(
    private readonly dir: string | null,
    stockSources: Record<string, { source: string; summary: string }> = {},
  ) {
    for (const [name, s] of Object.entries(stockSources)) {
      this.stock.set(name, {
        source: s.source,
        meta: { name, author: STOCK_AUTHOR, current: 1, versions: [{ v: 1, at: 0, request: 'stock', summary: s.summary }], shares: [], createdAt: 0 },
      });
    }
    if (dir && existsSync(dir)) {
      for (const uuid of readdirSync(dir)) {
        const authorDir = join(dir, uuid);
        for (const name of safeReaddir(authorDir)) {
          const f = join(authorDir, name, 'meta.json');
          if (!existsSync(f)) continue;
          try {
            const meta = JSON.parse(readFileSync(f, 'utf8')) as CommandMeta;
            this.metas.set(key(meta.author.uuid, meta.name), meta);
          } catch {
            /* a broken meta is skipped, not fatal */
          }
        }
      }
    }
  }

  /** Every player's commands (stock excluded). */
  all(): CommandMeta[] {
    return sortByName([...this.metas.values()]);
  }

  /** Commands a player can order: own, shared with them, stock (own names hide shared and stock ones). */
  list(player: string): { own: CommandMeta[]; shared: CommandMeta[]; stock: CommandMeta[] } {
    const own = [...this.metas.values()].filter((m) => m.author.uuid === player);
    const ownNames = new Set(own.map((m) => m.name));
    const shared = [...this.metas.values()].filter((m) => m.author.uuid !== player && m.shares.some((s) => s.uuid === player));
    const stock = [...this.stock.values()].map((s) => s.meta).filter((m) => !ownNames.has(m.name));
    return { own: sortByName(own), shared: sortByName(shared), stock: sortByName(stock) };
  }

  /** The command `ref` means for `player` (French errors: players read them). */
  resolve(player: string, ref: string): Resolved {
    const r = ref.trim();
    const colon = r.indexOf(':');
    if (colon > 0) {
      const owner = r.slice(0, colon).toLowerCase();
      const name = r.slice(colon + 1).toLowerCase();
      if (owner === STOCK_AUTHOR.name) return this.stockResolved(name);
      const m = [...this.metas.values()].find((x) => x.name === name && x.author.name.toLowerCase() === owner);
      if (!m) throw new StoreError(`commande inconnue : ${ref}`);
      if (m.author.uuid !== player && !m.shares.some((s) => s.uuid === player)) throw new StoreError(`${m.author.name} ne t'a pas partagé « ${name} »`);
      return this.resolved(m);
    }
    const name = r.toLowerCase();
    const own = this.metas.get(key(player, name));
    if (own) return this.resolved(own);
    const shared = [...this.metas.values()].filter((m) => m.name === name && m.shares.some((s) => s.uuid === player));
    if (shared.length > 1) {
      throw new StoreError(`plusieurs « ${name} » te sont partagées : précise ${shared.map((m) => `${m.author.name}:${name}`).join(' ou ')}`);
    }
    if (shared[0]) return this.resolved(shared[0]);
    if (this.stock.has(name)) return this.stockResolved(name);
    throw new StoreError(`commande inconnue : ${name} (/bots commands pour la liste)`);
  }

  /** The author's own command (for fix, share, delete, revert). */
  own(author: string, name: string): CommandMeta | undefined {
    const m = this.metas.get(key(author, name.toLowerCase()));
    return m ? structuredClone(m) : undefined;
  }

  source(author: string, name: string, v: number): string {
    if (author === STOCK_AUTHOR.uuid) {
      const s = this.stock.get(name);
      if (!s) throw new StoreError(`no stock command ${name}`);
      return s.source;
    }
    if (!this.dir) {
      const src = this.memory.get(`${key(author, name)}@${v}`);
      if (src === undefined) throw new StoreError(`version manquante : ${name} v${v}`);
      return src;
    }
    const f = this.file(author, name, `v${v}.mjs`);
    if (!existsSync(f)) throw new StoreError(`version manquante : ${name} v${v}`);
    return readFileSync(f, 'utf8');
  }

  /** Append a version and make it current. */
  addVersion(author: Player, name: string, source: string, info: { request: string; summary: string }): number {
    if (!COMMAND_NAME.test(name)) throw new StoreError(`nom de commande invalide « ${name} » (a-z, 0-9 et -, 2 à 32 caractères)`);
    const k = key(author.uuid, name);
    const meta: CommandMeta = this.metas.get(k) ?? { name, author: { ...author }, current: 0, versions: [], shares: [], createdAt: Date.now() };
    const v = (meta.versions.reduce((mx, x) => Math.max(mx, x.v), 0) || 0) + 1;
    meta.author.name = author.name; // a renamed player keeps their commands (uuid)
    meta.versions.push({ v, at: Date.now(), request: info.request.slice(0, 2000), summary: info.summary });
    meta.current = v;
    if (this.dir) {
      mkdirSync(this.file(author.uuid, name), { recursive: true });
      writeFileSync(this.file(author.uuid, name, `v${v}.mjs`), source);
    } else this.memory.set(`${k}@${v}`, source);
    this.metas.set(k, meta);
    this.saveMeta(meta);
    return v;
  }

  share(author: string, name: string, players: Player[]): CommandMeta {
    const meta = this.requireOwn(author, name);
    const by = new Map(meta.shares.map((p) => [p.uuid, p]));
    for (const p of players) if (p.uuid !== author) by.set(p.uuid, { uuid: p.uuid, name: p.name });
    meta.shares = [...by.values()];
    this.saveMeta(meta);
    return structuredClone(meta);
  }

  unshare(author: string, name: string, players: Player[]): CommandMeta {
    const meta = this.requireOwn(author, name);
    const gone = new Set(players.map((p) => p.uuid));
    meta.shares = meta.shares.filter((p) => !gone.has(p.uuid));
    this.saveMeta(meta);
    return structuredClone(meta);
  }

  revert(author: string, name: string, v: number): CommandMeta {
    const meta = this.requireOwn(author, name);
    if (!meta.versions.some((x) => x.v === v)) throw new StoreError(`« ${name} » n'a pas de version v${v} (versions : ${meta.versions.map((x) => 'v' + x.v).join(', ')})`);
    meta.current = v;
    this.saveMeta(meta);
    return structuredClone(meta);
  }

  /** Delete a command (for everyone it was shared with). The files are moved aside, not erased. */
  delete(author: string, name: string): CommandMeta {
    const meta = this.requireOwn(author, name);
    this.metas.delete(key(author, meta.name));
    if (this.dir) {
      const from = this.file(author, meta.name);
      const to = join(this.dir, '.deleted', `${author}-${meta.name}-${Date.now()}`);
      mkdirSync(join(this.dir, '.deleted'), { recursive: true });
      try {
        renameSync(from, to);
      } catch {
        rmSync(from, { recursive: true, force: true });
      }
    }
    return meta;
  }

  private requireOwn(author: string, name: string): CommandMeta {
    const m = this.metas.get(key(author, name.toLowerCase()));
    if (!m) throw new StoreError(`tu n'as pas de commande « ${name} »`);
    return m;
  }

  private resolved(m: CommandMeta): Resolved {
    return { meta: structuredClone(m), version: m.current, source: this.source(m.author.uuid, m.name, m.current), stock: false };
  }

  private stockResolved(name: string): Resolved {
    const s = this.stock.get(name);
    if (!s) throw new StoreError(`commande inconnue : squad:${name}`);
    return { meta: structuredClone(s.meta), version: 1, source: s.source, stock: true };
  }

  private file(author: string, name: string, leaf?: string): string {
    if (!this.dir) throw new StoreError('no data dir');
    return leaf ? join(this.dir, author, name, leaf) : join(this.dir, author, name);
  }

  private saveMeta(meta: CommandMeta): void {
    if (!this.dir) return;
    mkdirSync(this.file(meta.author.uuid, meta.name), { recursive: true });
    const f = this.file(meta.author.uuid, meta.name, 'meta.json');
    writeFileSync(`${f}.tmp`, JSON.stringify(meta, null, 2));
    renameSync(`${f}.tmp`, f);
  }
}

const key = (uuid: string, name: string): string => `${uuid}/${name}`;

function safeReaddir(d: string): string[] {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}

function sortByName(ms: CommandMeta[]): CommandMeta[] {
  return [...ms].sort((a, b) => a.name.localeCompare(b.name)).map((m) => structuredClone(m));
}
