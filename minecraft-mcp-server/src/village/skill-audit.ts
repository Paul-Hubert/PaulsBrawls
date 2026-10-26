import fs from 'fs';
import path from 'path';

/**
 * Append-only JSONL audit of every skill lifecycle event — the "log of all
 * created skills" the long-run benchmark analyzes. Synchronous appends on
 * purpose: skill events are rare (a handful per bot per hour) and the audit
 * must survive a crash that the 2s-debounced bot-state flush would lose.
 *
 * Events:
 *   created / updated / re-enabled / seeded-stock — via SkillLibrary.upsert
 *   removed                                       — via SkillLibrary.remove
 *   strike / disabled                             — via SkillLibrary.recordError
 *   rejected-validation / rejected-install        — write_skill drafts that
 *     never reach (or are rolled back out of) the library; only observable at
 *     the agent-tools call site.
 *
 * Uninitialized (tests, unified entrypoint) every append is a no-op.
 */

export type SkillAuditEventType =
  | 'created'
  | 'updated'
  | 're-enabled'
  | 'seeded-stock'
  | 'removed'
  | 'strike'
  | 'disabled'
  | 'rejected-validation'
  | 'rejected-install';

export interface SkillAuditEvent {
  bot: string;
  event: SkillAuditEventType;
  name: string;
  kind?: string;
  version?: number;
  description?: string;
  error?: string;
  errorCount?: number;
  code?: string;
}

let auditPath: string | null = null;

export function initSkillAudit(filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  auditPath = path.resolve(filePath);
  return auditPath;
}

/** For tests. */
export function resetSkillAudit(): void {
  auditPath = null;
}

export function auditSkill(event: SkillAuditEvent): void {
  if (!auditPath) return;
  try {
    fs.appendFileSync(auditPath, `${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`);
  } catch {
    /* best-effort — the audit must never break the skill pipeline */
  }
}
