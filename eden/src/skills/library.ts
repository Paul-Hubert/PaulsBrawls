// The skill library (layer 2) — the SOLE WRITER of skill state (S2) and Eden's core asset. One
// library, it belongs to God (owner #2): every villager draws from the same pool. Two invariants
// from the design carry the most weight:
//   • Append-only versioning. A rewrite creates v(k+1); v(k)'s file stays on disk forever (unlike
//     Voyager, which overwrites in place). `archived` is invisible to retrieval, visible to admin.
//   • The D-12 status machine. An LLM-admitted draft enters `active-probation` (globally runnable +
//     retrievable, but NOT composable by other skills until probationRuns clean runs); a quarantined
//     skill that re-succeeds self-heals to `active-probation`, NEVER straight to `active` (R37/R48).
//
// Live state is NOT event-sourced (S5): it persists to disk (per-skill skill.json + v<k>.js code
// files) and is reloaded at boot; the journal is the history product, written alongside (P4).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Author, JsonSchema, Provenance, SkillManifest, SkillVersion, Tier } from '../types/index';
import type { JournalAppender } from '../journal/journal';

/** The economy seam (owner #3). v0 ships only {@link AllGranted}; a LedgerGrants swaps in behind it. */
export interface GrantPolicy {
  /** May this villager SEE the skill in retrieval/prompts? */
  canRetrieve(villager: string, skill: string): boolean;
  /** May this villager EXECUTE the skill? */
  canRun(villager: string, skill: string): boolean;
}

/** v0: constant true. Every retrieval + every run already passes through it (no engine change later). */
export class AllGranted implements GrantPolicy {
  canRetrieve(_villager: string, _skill: string): boolean {
    return true;
  }
  canRun(_villager: string, _skill: string): boolean {
    return true;
  }
}

/** The input to {@link SkillLibrary.upsertDraft} — what `write_skill` carries. */
export interface DraftInput {
  name: string;
  summary: string;
  params: JsonSchema;
  returns: JsonSchema;
  code: string;
  author: Author;
  /** Default `mortal`. Divine is accepted only from God/admin — enforced at the tool layer, not here. */
  tier?: Tier;
  /** Filled by the DescriptionPass (M2-5) at admission; defaults to `summary` for a draft. */
  description?: string;
  tags?: string[];
  exemplar?: boolean;
}

/** A version resolved for execution / reading: its manifest, metadata, and source. */
export interface ResolvedSkill {
  manifest: SkillManifest;
  version: SkillVersion;
  code: string;
}

/** One version row + its manifest snapshot (the manifest can evolve across versions). */
interface VersionRecord {
  version: SkillVersion;
  manifest: SkillManifest;
}
interface SkillRecord {
  name: string;
  records: VersionRecord[];
}

/** Construction options for {@link SkillLibrary}. */
export interface SkillLibraryOptions {
  dataDir: string;
  journal: JournalAppender;
  /** Clean re-judged runs an admitted draft needs to graduate active-probation → active (D-12). */
  probationRuns: number;
  now?: () => number;
}

function sha256(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** The library. Constructing it loads any persisted state; call {@link verifyHashes} at boot. */
export class SkillLibrary {
  private readonly dataDir: string;
  private readonly journal: JournalAppender;
  private readonly probationRuns: number;
  private readonly now: () => number;
  private readonly skills = new Map<string, SkillRecord>();

  constructor(opts: SkillLibraryOptions) {
    this.dataDir = opts.dataDir;
    this.journal = opts.journal;
    this.probationRuns = opts.probationRuns;
    this.now = opts.now ?? Date.now;
    this.load();
  }

  // ── Authoring ──────────────────────────────────────────────────────────
  /** Upsert a draft (owner #8: same tool creates + updates). Creates a new draft version, never reuses. */
  upsertDraft(input: DraftInput): SkillVersion {
    assertSkillName(input.name); // bug #13: the name becomes a directory under library/
    // Windows folds case: `Go-To` would share go-to's directory and overwrite its files (review fix).
    for (const existing of this.skills.keys()) {
      if (existing !== input.name && existing.toLowerCase() === input.name.toLowerCase()) {
        throw new InvalidSkillNameError(input.name, `differs only in case from the existing skill "${existing}"`);
      }
    }
    const record = this.skills.get(input.name) ?? { name: input.name, records: [] };
    const version = this.nextVersion(record);
    const codePath = this.writeCode(input.name, version, input.code);
    const manifest = this.buildManifest(input);
    const sv: SkillVersion = {
      name: input.name,
      version,
      codePath,
      codeHash: sha256(input.code),
      status: 'draft',
      author: input.author,
      createdAt: this.now(),
    };
    record.records.push({ version: sv, manifest });
    this.skills.set(input.name, record);
    this.persist(input.name);
    this.journal.append(this.actor(input.author), 'skill.draft', {
      name: input.name,
      version,
      author: input.author,
      tier: manifest.tier,
      lines: input.code.split('\n').length,
    }, { skill: input.name, skillVersion: version });
    return sv;
  }

  /** Seed a stock/exemplar skill straight into a live status (curated review IS its probation, D-12). */
  seedStock(input: DraftInput, status: 'active' | 'active-probation' = 'active'): SkillVersion {
    const sv = this.upsertDraft({ ...input, author: { kind: 'stock', name: input.author.name } });
    const rec = this.find(input.name, sv.version)!;
    rec.version.status = status;
    if (status === 'active-probation') rec.version.probationRunsLeft = this.probationRuns;
    this.persist(input.name);
    return rec.version;
  }

  /**
   * Bug #12 — boot-time stock seeding. Appends a version ONLY when the stock code or seed manifest differs
   * from the newest stock-authored version, and never over an admitted override (a live non-stock version
   * newer than that stock version) — re-seeding used to append 37 versions + 37 `skill.draft` rows per boot
   * and re-shadow every admitted villager rewrite of a stock name.
   */
  seedStockIfChanged(input: DraftInput, status: 'active' | 'active-probation' = 'active'): 'seeded' | 'unchanged' | 'overridden' {
    const records = this.skills.get(input.name)?.records ?? [];
    const lastStock = [...records].reverse().find((r) => r.version.author.kind === 'stock');
    // 'unchanged' only while that stock version is still live: a quarantined/archived one (the boot hash check, a
    // critic or tripwire verdict) is healed with a fresh version, as every boot did before bug #12's fix.
    const lastLive = lastStock?.version.status === 'active' || lastStock?.version.status === 'active-probation';
    if (lastStock && lastLive && lastStock.version.codeHash === sha256(input.code) && sameSeed(lastStock.manifest, this.buildManifest(input))) {
      return 'unchanged';
    }
    const live = this.liveRecord(input.name);
    if (live && live.version.author.kind !== 'stock' && (!lastStock || live.version.version > lastStock.version.version)) {
      return 'overridden';
    }
    this.seedStock(input, status);
    return 'seeded';
  }

  // ── D-12 status machine (only the engine + God move these) ───────────────
  /** Admit a draft → active-probation (D-12), stamping provenance. The passing direction is gated. */
  admit(name: string, version: number, provenance: Provenance): SkillVersion {
    const rec = this.require(name, version);
    rec.version.status = 'active-probation';
    rec.version.probationRunsLeft = this.probationRuns;
    rec.version.provenance = provenance;
    this.persist(name);
    this.journal.append('god:critic', 'skill.admit', { name, version, provenance }, {
      skill: name,
      skillVersion: version,
      rolloutId: provenance.rolloutId,
      verdictId: provenance.verdictId,
    });
    return rec.version;
  }

  /** Record one re-judged run of the live probationary version; N clean runs graduate it to active. */
  recordProbationRun(name: string, ok: boolean): void {
    const rec = this.liveRecord(name);
    if (!rec || rec.version.status !== 'active-probation') return;
    if (!ok) return; // only CLEAN runs advance graduation (D-12)
    const left = (rec.version.probationRunsLeft ?? this.probationRuns) - 1;
    if (left <= 0) {
      rec.version.status = 'active';
      delete rec.version.probationRunsLeft;
    } else {
      rec.version.probationRunsLeft = left;
    }
    this.persist(name);
  }

  /** Quarantine a version (God/admin/tripwire/boot hash-mismatch). Defaults to the live version. Journals ONE
   *  `skill.quarantine` row, as `actor`, BEFORE the status changes (05) — an unknown skill journals nothing. */
  quarantine(name: string, reason: string, version?: number, actor = 'engine'): SkillVersion | undefined {
    const rec = version === undefined ? (this.liveRecord(name) ?? this.newestNonArchived(name)) : this.find(name, version);
    if (!rec) return undefined;
    this.journal.append(actor, 'skill.quarantine', { name, version: rec.version.version, reason }, {
      skill: name,
      skillVersion: rec.version.version,
    });
    rec.version.status = 'quarantined';
    delete rec.version.probationRunsLeft;
    this.persist(name);
    return rec.version;
  }

  /** Self-healing un-quarantine → active-probation (R37/R48), NEVER straight to active. */
  unquarantine(name: string, version?: number): SkillVersion | undefined {
    const rec =
      version === undefined
        ? [...(this.skills.get(name)?.records ?? [])].reverse().find((r) => r.version.status === 'quarantined')
        : this.find(name, version);
    if (!rec || rec.version.status !== 'quarantined') return undefined;
    rec.version.status = 'active-probation';
    rec.version.probationRunsLeft = this.probationRuns;
    this.persist(name);
    // Re-entering active-probation is an admission event (no provenance — it healed, wasn't proven fresh).
    this.journal.append('god:critic', 'skill.admit', { name, version: rec.version.version }, {
      skill: name,
      skillVersion: rec.version.version,
    });
    return rec.version;
  }

  /** Apply the DescriptionPass result (M2-5) at admission: replace description, optionally summary/tags. */
  applyDescription(name: string, version: number, patch: { description: string; summary?: string; tags?: string[] }): void {
    const rec = this.find(name, version);
    if (!rec) return;
    rec.manifest.description = patch.description;
    if (patch.summary !== undefined) rec.manifest.summary = patch.summary;
    if (patch.tags !== undefined) rec.manifest.tags = patch.tags;
    this.persist(name);
  }

  /** Archive a version — invisible to retrieval/default-read, still on disk + addressable by version. */
  archive(name: string, version: number): void {
    const rec = this.find(name, version);
    if (!rec) return;
    rec.version.status = 'archived';
    this.persist(name);
    this.journal.append('god:critic', 'skill.archive', { name, version }, { skill: name, skillVersion: version });
  }

  // ── Reads ────────────────────────────────────────────────────────────────
  /** The highest live (active / active-probation) version of a skill, or undefined. */
  activeVersion(name: string): SkillVersion | undefined {
    return this.liveRecord(name)?.version;
  }

  /** Any version by number (incl. draft / quarantined / archived) — addressable for trials + admin. */
  getVersion(name: string, version: number): SkillVersion | undefined {
    return this.find(name, version)?.version;
  }

  /** read_skill: default = newest non-archived; explicit version resolves any non-deleted version. */
  read(name: string, version?: number): ResolvedSkill | undefined {
    const rec = version === undefined ? this.newestNonArchived(name) : this.find(name, version);
    if (!rec) return undefined;
    return this.resolve(rec);
  }

  /** run_skill for normal work (P2): only the live (active / active-probation) version is runnable. */
  readRunnable(name: string): ResolvedSkill | undefined {
    const rec = this.liveRecord(name);
    return rec ? this.resolve(rec) : undefined;
  }

  /** The always-in-prompt exemplar set for a tier — live, exemplar-flagged skills only. */
  exemplars(tier: Tier): SkillVersion[] {
    const out: SkillVersion[] = [];
    for (const rec of this.skills.values()) {
      const live = this.liveRecord(rec.name);
      if (live && live.manifest.exemplar && live.manifest.tier === tier) out.push(live.version);
    }
    return out;
  }

  /** Every skill's live version — the retriever's candidate set (tier/grant-filtered there, P2). */
  liveSkills(): ResolvedSkill[] {
    const out: ResolvedSkill[] = [];
    for (const rec of this.skills.values()) {
      const live = this.liveRecord(rec.name);
      if (live) out.push(this.resolve(live));
    }
    return out;
  }

  /** Append-only version count of a skill (0 if unknown) — the admin list view's `versionsCount`. */
  versionCount(name: string): number {
    return this.skills.get(name)?.records.length ?? 0;
  }

  /**
   * Every version of a skill, newest-first, with its source — the admin version-history detail view.
   * Append-only history (versions are never deleted on disk); a missing code file degrades to `''` rather
   * than throwing, so the view stays renderable even mid-corruption.
   */
  history(name: string): Array<{ version: SkillVersion; manifest: SkillManifest; code: string }> {
    const rec = this.skills.get(name);
    if (!rec) return [];
    return [...rec.records].reverse().map((r) => ({
      version: r.version,
      manifest: r.manifest,
      code: existsSync(r.version.codePath) ? readFileSync(r.version.codePath, 'utf8') : '',
    }));
  }

  /** Boot integrity check: a code file whose hash drifted from its record is quarantined (tamper/corruption). */
  verifyHashes(): void {
    for (const rec of this.skills.values()) {
      for (const vr of rec.records) {
        if (vr.version.status === 'archived') continue;
        if (!existsSync(vr.version.codePath)) continue;
        const onDisk = sha256(readFileSync(vr.version.codePath, 'utf8'));
        if (onDisk !== vr.version.codeHash) {
          this.quarantine(rec.name, 'code hash mismatch at boot — file tampered or corrupted', vr.version.version);
        }
      }
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private buildManifest(input: DraftInput): SkillManifest {
    return {
      name: input.name,
      summary: input.summary,
      description: input.description ?? input.summary,
      params: input.params,
      returns: input.returns,
      signature: renderSignature(input.name, input.params, input.returns),
      tags: input.tags ?? [],
      tier: input.tier ?? 'mortal',
      exemplar: input.exemplar ?? false,
    };
  }

  private resolve(rec: VersionRecord): ResolvedSkill {
    return { manifest: rec.manifest, version: rec.version, code: readFileSync(rec.version.codePath, 'utf8') };
  }

  private liveRecord(name: string): VersionRecord | undefined {
    const records = this.skills.get(name)?.records ?? [];
    let best: VersionRecord | undefined;
    for (const r of records) {
      if (r.version.status === 'active' || r.version.status === 'active-probation') {
        if (!best || r.version.version > best.version.version) best = r;
      }
    }
    return best;
  }

  private newestNonArchived(name: string): VersionRecord | undefined {
    const records = this.skills.get(name)?.records ?? [];
    let best: VersionRecord | undefined;
    for (const r of records) {
      if (r.version.status !== 'archived') {
        if (!best || r.version.version > best.version.version) best = r;
      }
    }
    return best;
  }

  private find(name: string, version: number): VersionRecord | undefined {
    return this.skills.get(name)?.records.find((r) => r.version.version === version);
  }

  private require(name: string, version: number): VersionRecord {
    const rec = this.find(name, version);
    if (!rec) throw new Error(`skill ${name} v${version} not found in the library`);
    return rec;
  }

  private nextVersion(record: SkillRecord): number {
    return record.records.reduce((max, r) => Math.max(max, r.version.version), 0) + 1;
  }

  private actor(author: Author): string {
    if (author.kind === 'villager' && author.name) return `villager:${author.name}`;
    if (author.kind === 'god') return 'god:authoring';
    return 'engine';
  }

  private skillDir(name: string): string {
    return join(this.dataDir, 'library', name);
  }

  private writeCode(name: string, version: number, code: string): string {
    const dir = this.skillDir(name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `v${version}.js`);
    writeFileSync(path, code);
    return path;
  }

  private persist(name: string): void {
    const record = this.skills.get(name);
    if (!record) return;
    mkdirSync(this.skillDir(name), { recursive: true });
    writeFileSync(join(this.skillDir(name), 'skill.json'), JSON.stringify(record, null, 2));
  }

  private load(): void {
    const root = join(this.dataDir, 'library');
    if (!existsSync(root)) return;
    for (const name of readdirSync(root)) {
      const file = join(root, name, 'skill.json');
      if (!existsSync(file)) continue;
      try {
        const record = JSON.parse(readFileSync(file, 'utf8')) as SkillRecord;
        this.skills.set(record.name, record);
      } catch {
        // A corrupt index for one skill must not stop the rest from loading.
      }
    }
  }
}

/** The seed-relevant manifest fields (not `description`, which the describer may rewrite after admission). */
function sameSeed(a: SkillManifest, b: SkillManifest): boolean {
  const pick = (m: SkillManifest): string =>
    JSON.stringify([m.summary, m.params, m.returns, m.tags, m.tier, m.exemplar]);
  return pick(a) === pick(b);
}

/** A skill name that cannot be used as its `library/<name>/` directory (bug #13 — path traversal). */
export class InvalidSkillNameError extends Error {
  constructor(name: string, reason: string) {
    super(`invalid skill name ${JSON.stringify(name)}: ${reason} — use letters, digits, '-' or '_' (it names a directory under library/)`);
    this.name = 'InvalidSkillNameError';
  }
}

/** Reject a name that would nest (`/`, `\`), escape (`..`), hide (leading `.`), or misbehave as a
 *  directory name on the owner's Windows host (`:` opens an alternate data stream; control chars). */
export function assertSkillName(name: string): void {
  if (name.trim() === '') throw new InvalidSkillNameError(name, 'empty');
  if (/[/\\]/.test(name)) throw new InvalidSkillNameError(name, 'contains a path separator');
  if (name.includes('..')) throw new InvalidSkillNameError(name, "contains '..'");
  if (name.startsWith('.')) throw new InvalidSkillNameError(name, "starts with '.'");
  if (name.includes(':') || [...name].some((c) => c.charCodeAt(0) < 0x20)) {
    throw new InvalidSkillNameError(name, "contains ':' or a control character");
  }
  // Windows (the owner's host): <>"|?* are illegal, a trailing dot/space is silently dropped, and the device names
  // are reserved even with an extension (review fix).
  if (/[<>"|?*]/.test(name)) throw new InvalidSkillNameError(name, 'contains one of < > " | ? *');
  if (/[. ]$/.test(name)) throw new InvalidSkillNameError(name, 'ends with a dot or a space');
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(name)) throw new InvalidSkillNameError(name, 'is a reserved Windows device name');
}

function schemaType(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return 'any';
  const s = schema as Record<string, unknown>;
  const t = s['type'];
  if (t === 'array') return `${schemaType(s['items'])}[]`;
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string').join('|');
  return 'object';
}

function propsOf(schema: JsonSchema): Record<string, unknown> {
  const p = (schema as Record<string, unknown>)['properties'];
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
}

/** Render the prompt-facing signature line FROM the schemas (D-04: generated, so it can't lie). */
export function renderSignature(name: string, params: JsonSchema, returns: JsonSchema): string {
  const props = propsOf(params);
  const reqRaw = (params as Record<string, unknown>)['required'];
  const required = new Set(Array.isArray(reqRaw) ? reqRaw.filter((x): x is string => typeof x === 'string') : []);
  const args = Object.entries(props)
    .map(([k, v]) => `${k}${required.has(k) ? '' : '?'}: ${schemaType(v)}`)
    .join(', ');
  const rProps = propsOf(returns);
  const ret =
    Object.keys(rProps).length > 0
      ? `{${Object.entries(rProps).map(([k, v]) => `${k}: ${schemaType(v)}`).join(', ')}}`
      : schemaType(returns);
  return `${name}({${args}}) → ${ret}`;
}
