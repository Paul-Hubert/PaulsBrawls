import { tokenize } from './memory-index.js';
import { Persistence } from './persistence.js';
import { auditSkill } from './skill-audit.js';
import { Skill, SkillKind } from './types.js';

/**
 * Per-villager skill storage + lifecycle state (VILLAGE_PLAN §4).
 * Pure bookkeeping — validation/instrumentation/execution live in
 * reflex-engine.ts; this class owns versioning and the 3-strikes breaker.
 */

export const MAX_SKILL_ERRORS = 3;
const MAX_AUTHORED_SKILLS = 24;
const MAX_PROMPT_CODE_CHARS = 1_500;

export class SkillLibrary {
  private readonly botName: string;
  private readonly persistence: Persistence;

  constructor(botName: string, persistence: Persistence) {
    this.botName = botName;
    this.persistence = persistence;
  }

  private skills(): Skill[] {
    return this.persistence.botState(this.botName).skills;
  }

  list(): Skill[] {
    return [...this.skills()];
  }

  get(name: string): Skill | undefined {
    return this.skills().find((s) => s.name === name);
  }

  active(kind?: SkillKind): Skill[] {
    return this.skills().filter((s) => s.status === 'active' && (!kind || s.kind === kind));
  }

  /**
   * Insert or replace a skill. Replacement bumps the version and clears the
   * strike counter (a rewrite earns a fresh chance).
   */
  upsert(draft: { name: string; kind: SkillKind; description: string; code: string; stock?: boolean }): Skill {
    if (!/^[a-z0-9_-]{1,48}$/i.test(draft.name)) {
      throw new Error(`bad skill name '${draft.name}' — use letters/digits/_/- (max 48 chars)`);
    }
    const all = this.skills();
    const existing = all.find((s) => s.name === draft.name);
    if (!existing && !draft.stock && all.filter((s) => !s.stock).length >= MAX_AUTHORED_SKILLS) {
      throw new Error(`skill limit reached (${MAX_AUTHORED_SKILLS}) — remove one first`);
    }
    const wasDisabled = existing?.status === 'disabled';
    let skill: Skill;
    if (existing) {
      existing.kind = draft.kind;
      existing.description = draft.description;
      existing.code = draft.code;
      existing.version += 1;
      existing.status = 'active';
      existing.errorCount = 0;
      existing.lastError = undefined;
      // A bot rewrite (draft.stock undefined) CLEARS the flag — the skill is
      // now the bot's own, and boot-time stock reseeding must leave it alone.
      existing.stock = draft.stock === true;
      skill = existing;
    } else {
      skill = {
        name: draft.name,
        kind: draft.kind,
        description: draft.description.slice(0, 200),
        code: draft.code,
        version: 1,
        status: 'active',
        errorCount: 0,
        stock: draft.stock,
      };
      all.push(skill);
    }
    this.persistence.markDirty(this.botName);
    auditSkill({
      bot: this.botName,
      event: draft.stock === true ? 'seeded-stock' : !existing ? 'created' : wasDisabled ? 're-enabled' : 'updated',
      name: skill.name,
      kind: skill.kind,
      version: skill.version,
      description: skill.description,
      code: skill.code,
    });
    return skill;
  }

  remove(name: string): boolean {
    const all = this.skills();
    const idx = all.findIndex((s) => s.name === name);
    if (idx === -1) return false;
    const [removed] = all.splice(idx, 1);
    this.persistence.markDirty(this.botName);
    auditSkill({ bot: this.botName, event: 'removed', name, kind: removed.kind, version: removed.version });
    return true;
  }

  /**
   * Record a runtime failure. Returns true if this strike tripped the
   * circuit breaker (skill now disabled — the bot should be told to fix it).
   */
  recordError(name: string, error: string): boolean {
    const skill = this.get(name);
    if (!skill) return false;
    skill.errorCount += 1;
    skill.lastError = error.slice(0, 300);
    let tripped = false;
    if (skill.errorCount >= MAX_SKILL_ERRORS && skill.status === 'active') {
      skill.status = 'disabled';
      tripped = true;
    }
    this.persistence.markDirty(this.botName);
    auditSkill({
      bot: this.botName,
      event: tripped ? 'disabled' : 'strike',
      name: skill.name,
      kind: skill.kind,
      version: skill.version,
      error: skill.lastError,
      errorCount: skill.errorCount,
    });
    return tripped;
  }

  /**
   * Skill names most relevant to a situation, by token overlap between the
   * query and each skill's name + description (Voyager-style retrieval,
   * keyword flavor — with ≤24 skills per bot a semantic index buys nothing).
   */
  relevantSkills(query: string, k: number): Set<string> {
    const queryTokens = new Set(tokenize(query));
    if (queryTokens.size === 0) return new Set();
    const scored: Array<[string, number]> = [];
    for (const skill of this.skills()) {
      let score = 0;
      for (const token of tokenize(`${skill.name.replace(/[-_]/g, ' ')} ${skill.description}`)) {
        if (queryTokens.has(token)) score++;
      }
      if (score > 0) scored.push([skill.name, score]);
    }
    return new Set(scored.sort((a, b) => b[1] - a[1]).slice(0, k).map(([name]) => name));
  }

  /**
   * Prompt listing for one skill layer. Skills in `fullCodeFor` — plus every
   * DISABLED skill (you can only fix code you can see) — include their code;
   * the rest are one-liners. Pass nothing to include code for everything
   * (the pre-M13 behavior).
   */
  promptBlock(kind: SkillKind, fullCodeFor?: ReadonlySet<string>): string {
    const skills = this.skills().filter((s) => s.kind === kind);
    if (skills.length === 0) return '(none yet)';
    return skills
      .map((s) => {
        const status = s.status === 'active' ? '' : ` [DISABLED after ${s.errorCount} errors: ${s.lastError ?? '?'}]`;
        const header = `${s.name}${s.stock ? ' (stock)' : ''} — ${s.description}${status}`;
        const showCode = !fullCodeFor || fullCodeFor.has(s.name) || s.status !== 'active';
        if (!showCode) return header;
        const code = s.code.length > MAX_PROMPT_CODE_CHARS
          ? `${s.code.slice(0, MAX_PROMPT_CODE_CHARS)}\n// … truncated (${s.code.length} chars total — a write_skill replace shows the new code in full)`
          : s.code;
        return `${header}\n\`\`\`js\n${code}\n\`\`\``;
      })
      .join('\n\n');
  }
}
