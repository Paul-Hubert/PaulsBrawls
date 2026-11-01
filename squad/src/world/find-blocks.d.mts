// Types of find-blocks.mjs: mineflayer's findBlocks over the shared world (docs/37 P6).

import type { StateTables, WorldReader } from './reader.mjs';

export const DEFAULT_MAX_DISTANCE: number;
export const DEFAULT_COUNT: number;
export const MIN_STEP_MS: number;

/** What to match: block ids (the registry's), block names (with or without `minecraft:`), state ids; any mix. */
export interface BlockQuery {
  blocks?: number[];
  names?: string[];
  states?: number[];
}

/** A search (the `findBlocks` job's input): mineflayer's options, plus the dimension (the store's name for it). */
export interface FindBlocksInput extends BlockQuery {
  /** The dimension as the store names it (SharedWorld.dimensionOf(bot), e.g. "minecraft:overworld"). */
  dim: string;
  /** The point searched from (mineflayer: `options.point || bot.entity.position`); floored. */
  x: number;
  y: number;
  z: number;
  /** Default 16, as mineflayer. */
  maxDistance?: number;
  /** Default 1, as mineflayer. */
  count?: number;
}

/** A finished search. */
export interface FindBlocksAnswer {
  /** [x0, y0, z0, x1, …]: mineflayer's findBlocks order (nearest first, stable), at most `count`. */
  positions: number[];
  /** Hits within maxDistance before the cut to `count`. */
  hits: number;
  /** Sections walked (in a live column, inside the world's height, each once). */
  sections: number;
  /** Of those, the ones whose block data was read (the rest: all air, one state, or out of range). */
  scanned: number;
  /** Section visits that met an unknown column (never received, unloaded, or cached). */
  unknown: number;
  /** Steps it took (1 + the times it continued on a later tick). */
  slices: number;
}

/** A search between steps (opaque: it stays on the thread that started it). */
export interface Search {
  readonly done: boolean;
  readonly dim: string;
  readonly count: number;
  readonly maxDistance: number;
}

/** prismarine-world's OctahedronIterator over integers (tests check it point for point). */
export class Octahedron {
  constructor(sx: number, sy: number, sz: number, maxDistance: number);
  readonly apothem: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** The next point into nx, ny, nz; false at the end. */
  next(): boolean;
}

export function matchTable(states: StateTables, query: BlockQuery): Uint8Array;
export function matchKey(query: BlockQuery): string;
/** `visible(chunkX, chunkZ)` (main thread only, P5) limits the search to one bot's columns. */
export type ColumnFilter = (chunkX: number, chunkZ: number) => boolean;
export function startSearch(reader: WorldReader, input: FindBlocksInput, match: Uint8Array, visible?: ColumnFilter | null): Search;
/** Walk until done (true) or the budget falls under MIN_STEP_MS (false); at least one section per call. */
export function stepSearch(reader: WorldReader, search: Search, budgetLeftMs?: () => number): boolean;
export function answerOf(search: Search): FindBlocksAnswer;
export function findBlocksIn(reader: WorldReader, input: FindBlocksInput, match?: Uint8Array, visible?: ColumnFilter | null): FindBlocksAnswer;
