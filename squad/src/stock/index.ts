// The stock commands (src/stock/*.mjs): usable by everyone as `squad:NAME` (or plain NAME when the player has no
// command of that name), and the author agent's worked examples (read_command squad:NAME). Loaded at boot; a
// stock file that does not pass the checks is a bug that stops the boot.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkScript } from '../script/check';

export const STOCK_DIR = dirname(fileURLToPath(import.meta.url));

export function stockFiles(): Array<{ name: string; source: string }> {
  return readdirSync(STOCK_DIR)
    .filter((f) => f.endsWith('.mjs'))
    .sort()
    .map((f) => ({ name: f.replace(/\.mjs$/, ''), source: readFileSync(join(STOCK_DIR, f), 'utf8') }));
}

export async function loadStock(): Promise<Record<string, { source: string; summary: string }>> {
  const out: Record<string, { source: string; summary: string }> = {};
  for (const { name, source } of stockFiles()) {
    const r = await checkScript(source, { typecheck: false });
    if (!r.ok || !r.manifest) throw new Error(`stock command ${name} is broken: ${r.diagnostics.map((d) => d.message).join('; ')}`);
    out[name] = { source, summary: r.manifest.summary };
  }
  return out;
}
