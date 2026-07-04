// The D-17 server-properties overlay. The CI lifecycle swaps `run/server.properties` for a CI profile
// (flat, fixed-seed `eden-ci` world) behind a STAMPED backup, and restores it on teardown. Facts that
// shaped this (docs/26 §1.2 / P-20):
//   • The working-tree file is git-tracked AND locally modified — restore-to-backup, never restore-to-HEAD.
//   • Minecraft REWRITES the whole file on boot (re-serialized, reordered) — the overlay is a full-file
//     rewrite and the restore a full-file replace; a line-patch races that.
//   • Java Properties colon-escaping: `level-type=minecraft\:flat`. A malformed value silently falls
//     back to a NORMAL world (no error) — defeating determinism; the B1 ready-gate's flat-block probe
//     is the loud check, this module's job is to emit the escaping correctly.
//   • The backup is stamped with a marker header so a crashed prior run heals (restore-first) and a
//     FOREIGN file is never blindly restored.
// Pure text transforms live at the top (unit-tested per-push, tests/server-overlay.test.ts); the thin
// fs wrappers at the bottom are exercised by the lifecycle smoke.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

/** First line of a valid CI backup of server.properties. `#` keeps it a legal properties comment. */
export const BACKUP_STAMP = '# EDEN-CI-BACKUP v1 — restore me to run/server.properties (docs/26 B1 / D-17)';

/** The CI world profile. `level-type` carries the Properties colon-escape LITERALLY (P-20). */
export const CI_OVERRIDES: Readonly<Record<string, string>> = {
  'level-name': 'eden-ci',
  'level-type': 'minecraft\\:flat',
  'level-seed': '6072026', // fixed — reproducible flat world (docs/24 §7 criterion 8)
  'difficulty': 'peaceful', // the B1 gamerule baseline sits ON TOP of peaceful (docs/26 B1 step 7.3)
  'enable-rcon': 'true',
};

/** Parse a flat `key=value` properties file into an ordered map (values kept RAW — still escaped). */
export function parseProperties(text: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    props.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return props;
}

/** Serialize an ordered map back to a properties file — LF-normalized, trailing newline. */
export function serializeProperties(props: Map<string, string>): string {
  const lines = ['#Minecraft server properties', '# (EDEN-CI OVERLAY — a stamped backup of the original sits beside this file)'];
  for (const [k, v] of props) lines.push(`${k}=${v}`);
  return lines.join('\n') + '\n';
}

/**
 * Build the CI overlay from the working-tree file's text: a FULL-FILE rewrite carrying every original
 * key, with {@link CI_OVERRIDES} applied on top. Throws if the original lacks RCON facts the ready-gate
 * needs (S10 — fail here, not as a downstream connect timeout).
 */
export function buildOverlay(originalText: string): string {
  const props = parseProperties(originalText);
  if (!props.get('rcon.password')) {
    throw new Error('properties-overlay: run/server.properties has no rcon.password — the ready-gate cannot poll RCON without one');
  }
  for (const [k, v] of Object.entries(CI_OVERRIDES)) props.set(k, v);
  return serializeProperties(props);
}

/** Prefix the original file's text with the stamp so the backup is self-identifying. */
export function stampBackup(originalText: string): string {
  return BACKUP_STAMP + '\n' + originalText;
}

/** The original text of a stamped backup, or null if the text is NOT a valid CI backup (foreign file). */
export function unstampBackup(backupText: string): string | null {
  const nl = backupText.indexOf('\n');
  if (nl < 0 || backupText.slice(0, nl).trimEnd() !== BACKUP_STAMP) return null;
  return backupText.slice(nl + 1);
}

/** Where the stamped backup of `propsPath` lives. */
export function backupPathOf(propsPath: string): string {
  return propsPath + '.ci-backup';
}

/**
 * Crash-healing (B1 total-order step 1): if a leftover backup exists from a crashed prior run, restore
 * it FIRST — so the working-tree file we then back up is the real dev profile, not a stale CI overlay.
 * A backup without the stamp is a foreign file: never blindly restored (throws, operator decides).
 */
export function healLeftoverBackup(propsPath: string): 'none' | 'healed' {
  const backupPath = backupPathOf(propsPath);
  if (!existsSync(backupPath)) return 'none';
  const original = unstampBackup(readFileSync(backupPath, 'utf8'));
  if (original === null) {
    throw new Error(
      `properties-overlay: ${backupPath} exists but carries no "${BACKUP_STAMP.slice(0, 20)}…" stamp — foreign file, refusing to restore it. Inspect and remove it by hand.`,
    );
  }
  writeFileSync(propsPath, original, 'utf8');
  unlinkSync(backupPath);
  return 'healed';
}

/** B1 step 5: back up the WORKING-TREE file (stamped), then write the overlay in its place. */
export function backupAndOverlay(propsPath: string): void {
  const original = readFileSync(propsPath, 'utf8');
  writeFileSync(backupPathOf(propsPath), stampBackup(original), 'utf8');
  writeFileSync(propsPath, buildOverlay(original), 'utf8');
}

/** Teardown step 8: put the original back from the stamped backup, then remove the backup. */
export function restoreFromBackup(propsPath: string): void {
  const backupPath = backupPathOf(propsPath);
  if (!existsSync(backupPath)) {
    throw new Error(`properties-overlay: no backup at ${backupPath} — cannot restore ${propsPath}`);
  }
  const original = unstampBackup(readFileSync(backupPath, 'utf8'));
  if (original === null) {
    throw new Error(`properties-overlay: ${backupPath} is not a stamped CI backup — refusing to restore from it`);
  }
  writeFileSync(propsPath, original, 'utf8');
  unlinkSync(backupPath);
}
