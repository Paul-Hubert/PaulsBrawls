// RunReport → string (layer 1) — the shared rendering of a skill run's evidence, used by the
// villager's density payload (M3-1) and God's critic context (M3-4). The critic judges WORLD DELTA
// (R34/R35): completion ≠ progress. So the render foregrounds outcome + abort + before/after
// snapshots + the call tree, and prints the error VERBATIM (D-11: the critic is the one consumer
// for whom evidence is never elided).
//
// render/ imports only types/ (+ its own render/snapshot) — so both god/ and villagers/ can use it.

import type { RunReport } from '../types/index';
import { renderSnapshot } from './snapshot';

/** Render a {@link RunReport} to a compact, deterministic evidence block. */
export function renderRunReport(r: RunReport): string {
  const lines: string[] = [];
  lines.push(`skill=${r.skill} v${r.version} villager=${r.villager} durationMs=${r.durationMs} pulses=${r.pulses}`);
  lines.push(`args=${stableJson(r.args)}`);
  if (r.outcome.ok) {
    lines.push(`outcome=OK value=${stableJson(r.outcome.value)}`);
  } else {
    lines.push(`outcome=FAIL errorKind=${r.outcome.errorKind ?? '(none)'} error=${r.outcome.error}`);
  }
  if (r.aborted) lines.push(`aborted=${r.aborted}`);
  if (r.callTree.length > 0) {
    lines.push(`callTree: ${r.callTree.map((f) => `${f.skill}@v${f.version}${f.ok ? '' : '✗'}(${f.ms}ms)`).join(' → ')}`);
  }
  lines.push('--- monde AVANT ---');
  lines.push(r.worldBefore ? renderSnapshot(r.worldBefore) : '(aucun)');
  lines.push('--- monde APRÈS ---');
  lines.push(r.worldAfter ? renderSnapshot(r.worldAfter) : '(aucun)');
  return lines.join('\n');
}

/** JSON with sorted keys so the render is byte-stable across runs (S6). */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) sorted[k] = (v as Record<string, unknown>)[k];
      return sorted;
    }
    return v;
  });
}
