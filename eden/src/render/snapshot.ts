// The ONE Voyager-style Snapshot→string renderer (layer 1), shared by villager context packs
// (M3-1) and God's critic desk (M3-4). 02 §Retrieval: "every prompt that asks for code or
// judgment carries a rendered world snapshot in Voyager's flat format." Keeping it in ONE place
// is the point — the villager and the critic must see the world the same way, or a critique
// reasons about a different scene than the run produced.
//
// It lives in render/ (imports only types/) precisely so god/ and villagers/ can both import it
// without importing each other (the dependency law forbids layer-3 peers from meeting directly).
//
// Deterministic by construction (S6): same Snapshot → byte-identical string. Entities are sorted
// nearest-first (02), distances rounded so a sub-block jitter never changes the golden.

import type { Snapshot } from '../types/index';

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Render a {@link Snapshot} to Voyager's flat one-block-per-line text form. */
export function renderSnapshot(s: Snapshot): string {
  const [x, y, z] = s.position;
  const lines: string[] = [];
  lines.push(
    `biome=${s.biome} time=${s.time} pos=${round1(x)},${round1(y)},${round1(z)} hp=${s.health}/20 food=${s.hunger}/20`,
  );
  lines.push(`equipment: ${s.equipment.length > 0 ? s.equipment.join(', ') : '(none)'}`);
  lines.push(
    `inventory: ${s.inventory.length > 0 ? s.inventory.map((i) => `${i.name}×${i.count}`).join(', ') : '(empty)'}`,
  );
  const entities = [...s.nearbyEntities]
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .map((e) => `${e.name}@${round1(e.distance)}m`);
  lines.push(`entities: ${entities.length > 0 ? entities.join(', ') : '(none)'}`);
  lines.push(`blocks: ${s.nearbyBlocks.length > 0 ? s.nearbyBlocks.join(', ') : '(none)'}`);
  lines.push(
    `chests: ${s.knownChests.length > 0 ? s.knownChests.map(([cx, cy, cz]) => `${cx},${cy},${cz}`).join(' | ') : '(none)'}`,
  );
  return lines.join('\n');
}
