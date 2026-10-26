import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

/**
 * On-demand ASCII relief snapshot for a village bot — the Mineflayer-side
 * analogue of the God's Java `QueryTerrain` tool.
 *
 * Unlike `buildObservation` (which captures nearby ENTITIES every turn and must
 * stay small), this reads the TERRAIN around the bot and is only produced when
 * explicitly asked for — either by the LLM via the `survey_terrain` deliberation
 * tool or by skill code via `bot.surveyTerrain(...)`. Keeping it out of the
 * automatic per-turn observation is deliberate: a full grid would blow the
 * ~2-3k-token observation budget every deliberation.
 *
 * Mineflayer has no server-style heightmap cache, so each (x,z) column is found
 * by scanning DOWN from a Y window around the bot until the first non-air,
 * non-fluid block (the "surface"). The scan is bounded (`SCAN_UP`/`SCAN_DOWN`
 * around the bot's feet) so cost stays O(GRID² · scanHeight) — a few thousand
 * cheap `blockAt` reads against already-loaded chunks. Columns whose chunk is
 * not loaded render as `?` (Mineflayer's `blockAt` returns null there); we never
 * trigger a chunk load.
 *
 * ## ASCII encoding
 *
 * The body is always a `GRID`×`GRID` block of glyphs (default 16×16). Each cell
 * summarises one sampled column:
 *
 *   - `@`             — the bot's own column (center cell), overrides everything.
 *   - `?`             — column in an unloaded chunk; not sampled.
 *   - ` .:-=+*#%X`    — ELEVATION ramp, low→high, mapped across the visible Y
 *                       range of the snapshot (so it is relief-relative, not
 *                       absolute). `X` is the highest band (` `=lowest).
 *   - `~`            — water surface (fluid at the column top).
 *   - `T`            — tree/leaves/log surface (walkable-over obstacle).
 *   - `^`            — a column whose surface is more than `STEEP` blocks above
 *                       its 4-neighbour average (cliff/wall the bot can't climb).
 *
 * Water/tree/steep glyphs take priority over the elevation ramp so the bot can
 * spot hazards and resources at a glance; the header's Y range + slope still
 * describe the underlying relief. Row 0 is north (−Z), the last row south (+Z);
 * column 0 is west (−X), the last column east (+X). A header line names the
 * center, the sampled radius/step, the Y range, and the dominant slope
 * direction; a `LEGEND` line restates the glyph meanings for the model.
 */

/** Output grid dimension. 16×16 keeps the token cost ~constant (~500-700 tok). */
const GRID = 16;
/** Low→high elevation shading ramp. Other glyphs (`~ T ^ @ ?`) are reserved. */
const SHADE = ' .:-=+*#%X'.split('');
const DEFAULT_RADIUS = 24;
const MIN_RADIUS = 8;
const MAX_RADIUS = 48;
/** Blocks to scan up from / down from the bot's feet when hunting the surface. */
const SCAN_UP = 24;
const SCAN_DOWN = 40;
/** A column this many blocks above its neighbour average reads as a cliff (`^`). */
const STEEP = 3;

export interface SurveyOptions {
  /** Half-width of the sampled square, in blocks. Clamped 8..48, default 24. */
  radius?: number;
}

type SurfaceKind = 'ground' | 'water' | 'tree' | 'unloaded';

interface Column {
  y: number;
  kind: SurfaceKind;
  surface: string; // block name at the surface, '' when unloaded
}

const WATER_BLOCKS: ReadonlySet<string> = new Set(['water', 'flowing_water', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'bubble_column']);
const TREE_SUBSTRINGS = ['log', 'leaves', 'wood', 'mushroom_block', 'mushroom_stem'];

/** A block we treat as "see-through" when hunting the solid surface beneath. */
function isPassable(name: string): boolean {
  if (name === 'air' || name === 'cave_air' || name === 'void_air') return true;
  // Vegetation / non-collidable decoration the bot can stand on top of.
  return (
    name.includes('grass') && !name.includes('grass_block') ||
    name === 'snow' || name === 'fern' || name === 'large_fern' ||
    name.endsWith('_flower') || name === 'dandelion' || name === 'poppy' ||
    name.endsWith('_sapling') || name === 'dead_bush' || name === 'sugar_cane' ||
    name.endsWith('_carpet') || name === 'vine' || name === 'sweet_berry_bush'
  );
}

function isWater(name: string): boolean {
  return WATER_BLOCKS.has(name);
}

function isTree(name: string): boolean {
  return TREE_SUBSTRINGS.some((s) => name.includes(s));
}

/**
 * Find the surface column at world (x,z): scan from `topY` downward to `bottomY`
 * for the first non-passable block. Returns `kind: 'unloaded'` if the chunk
 * isn't loaded (any read in the column comes back null), so the renderer can
 * draw `?` rather than a misleading surface.
 */
function sampleColumn(bot: Bot, x: number, z: number, topY: number, bottomY: number): Column {
  let sawNull = false;
  let waterTop: number | null = null;
  for (let y = topY; y >= bottomY; y--) {
    const block = bot.blockAt(new Vec3(x, y, z));
    if (!block) {
      sawNull = true;
      continue;
    }
    const name = block.name;
    if (isWater(name)) {
      if (waterTop === null) waterTop = y; // remember the water line, keep digging for the bed
      continue;
    }
    if (isPassable(name)) continue;
    // First solid block. If we passed through water above it, it's a water column.
    if (waterTop !== null) return { y: waterTop, kind: 'water', surface: 'water' };
    if (isTree(name)) return { y, kind: 'tree', surface: name };
    return { y, kind: 'ground', surface: name };
  }
  if (waterTop !== null) return { y: waterTop, kind: 'water', surface: 'water' };
  // Nothing solid found in the window. If we only ever saw null, the chunk is
  // unloaded; otherwise it's genuinely open air (e.g. above the void) — treat
  // the floor of the scan as the surface so the cell still renders.
  if (sawNull) return { y: bottomY, kind: 'unloaded', surface: '' };
  return { y: bottomY, kind: 'ground', surface: 'air' };
}

/**
 * Build the ASCII relief snapshot string. Pure read — no movement, no world
 * mutation, safe to call from the perception (sync) seam. Returns a short
 * fallback string if the bot has no body or its own column can't be read.
 */
export function surveyTerrain(bot: Bot, opts: SurveyOptions = {}): string {
  if (!bot || !bot.entity) return 'survey_terrain: you are not in the world right now.';

  const r = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, Math.floor(opts.radius ?? DEFAULT_RADIUS)));
  // Map the 2r-wide window onto GRID cells. At r=8 step=1 (full res); at r=48
  // step=6 (coarse overview). Odd step keeps the bot near a cell center.
  const step = Math.max(1, Math.floor((2 * r) / GRID));

  const cx = Math.floor(bot.entity.position.x);
  const cz = Math.floor(bot.entity.position.z);
  const feetY = Math.floor(bot.entity.position.y);
  const topY = feetY + SCAN_UP;
  const bottomY = feetY - SCAN_DOWN;

  const cols: Column[][] = [];
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let loadedCells = 0;

  for (let gz = 0; gz < GRID; gz++) {
    const row: Column[] = [];
    for (let gx = 0; gx < GRID; gx++) {
      const worldX = cx - r + gx * step;
      const worldZ = cz - r + gz * step;
      const col = sampleColumn(bot, worldX, worldZ, topY, bottomY);
      row.push(col);
      if (col.kind !== 'unloaded') {
        loadedCells++;
        if (col.y < minY) minY = col.y;
        if (col.y > maxY) maxY = col.y;
      }
    }
    cols.push(row);
  }

  if (loadedCells === 0 || minY > maxY) {
    return `survey_terrain: the area around (${cx},${cz}) is not loaded yet — move closer or wait a moment.`;
  }

  // The grid cell holding the bot (center of the window).
  const botGX = Math.round((cx - (cx - r)) / step); // == Math.round(r/step)
  const botGZ = botGX;

  // Slope: mean surface Y of the east vs west edge and south vs north edge,
  // counting only loaded cells.
  let avgW = 0, avgE = 0, avgN = 0, avgS = 0;
  let nW = 0, nE = 0, nN = 0, nS = 0;
  for (let g = 0; g < GRID; g++) {
    const w = cols[g][0], e = cols[g][GRID - 1], n = cols[0][g], s = cols[GRID - 1][g];
    if (w.kind !== 'unloaded') { avgW += w.y; nW++; }
    if (e.kind !== 'unloaded') { avgE += e.y; nE++; }
    if (n.kind !== 'unloaded') { avgN += n.y; nN++; }
    if (s.kind !== 'unloaded') { avgS += s.y; nS++; }
  }
  const slope = (nW && nE && nN && nS)
    ? describeSlope(avgE / nE - avgW / nW, avgS / nS - avgN / nN)
    : 'unknown (edge unloaded)';

  const span = Math.max(1, maxY - minY);
  const rampMax = SHADE.length - 1;

  const lines: string[] = [];
  lines.push(
    `Terrain — center=(${cx},${cz}) radius=${r} step=${step} (each cell ≈ ${step}×${step} blocks)`,
  );
  lines.push(
    `Y range ${minY}..${maxY} (Δ${maxY - minY}), botY=${feetY}, slope=${slope}`,
  );
  lines.push(
    "LEGEND: '@'=you  '~'=water  'T'=tree/leaves  '^'=cliff (steep step up)  '?'=unloaded  " +
    `'${SHADE.join('')}'=ground low→high.  Top row=north(−Z), bottom=south(+Z); left=west(−X), right=east(+X).`,
  );

  for (let gz = 0; gz < GRID; gz++) {
    let line = '';
    for (let gx = 0; gx < GRID; gx++) {
      line += glyphFor(cols, gz, gx, gz === botGZ && gx === botGX, minY, span, rampMax) + ' ';
    }
    lines.push(line.trimEnd());
  }

  return lines.join('\n');
}

/** Pick the single glyph for one grid cell, applying the priority order. */
function glyphFor(
  cols: Column[][],
  gz: number,
  gx: number,
  isBot: boolean,
  minY: number,
  span: number,
  rampMax: number,
): string {
  if (isBot) return '@';
  const col = cols[gz][gx];
  if (col.kind === 'unloaded') return '?';
  if (col.kind === 'water') return '~';
  if (col.kind === 'tree') return 'T';

  // Cliff detection: surface this much higher than its loaded 4-neighbours.
  const neighbours: number[] = [];
  for (const [dz, dx] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const nz = gz + dz, nx = gx + dx;
    if (nz < 0 || nz >= GRID || nx < 0 || nx >= GRID) continue;
    const n = cols[nz][nx];
    if (n.kind !== 'unloaded') neighbours.push(n.y);
  }
  if (neighbours.length > 0) {
    const avg = neighbours.reduce((a, b) => a + b, 0) / neighbours.length;
    if (col.y - avg >= STEEP) return '^';
  }

  const idx = Math.max(0, Math.min(rampMax, Math.round(((col.y - minY) / span) * rampMax)));
  return SHADE[idx];
}

/** Maps a (dx,dz) elevation gradient to a cardinal/diagonal slope string. */
function describeSlope(dx: number, dz: number): string {
  const mag = Math.sqrt(dx * dx + dz * dz);
  if (mag < 1.5) return `flat (Δ${mag.toFixed(1)})`;
  // atan2(dz, dx) with world convention east=+X, south=+Z: 0=E, 90=S, ±180=W, -90=N.
  const ang = (Math.atan2(dz, dx) * 180) / Math.PI;
  let dir: string;
  if (ang >= -22.5 && ang < 22.5) dir = 'E';
  else if (ang >= 22.5 && ang < 67.5) dir = 'SE';
  else if (ang >= 67.5 && ang < 112.5) dir = 'S';
  else if (ang >= 112.5 && ang < 157.5) dir = 'SW';
  else if (ang >= -67.5 && ang < -22.5) dir = 'NE';
  else if (ang >= -112.5 && ang < -67.5) dir = 'N';
  else if (ang >= -157.5 && ang < -112.5) dir = 'NW';
  else dir = 'W';
  return `rising toward ${dir} (Δ${mag.toFixed(1)})`;
}
