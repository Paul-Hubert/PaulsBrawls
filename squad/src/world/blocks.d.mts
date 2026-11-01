// Types of blocks.mjs: prismarine Blocks over the shared world, one template per state id.

import type { WorldReader } from './reader.mjs';

interface Vec {
  x: number;
  y: number;
  z: number;
}

/** A prismarine-block Block, as far as this module knows it (the real class is in the template's prototype chain). */
export interface BlockLike {
  type: number;
  name: string;
  stateId: number;
  shapes: number[][];
  boundingBox: string;
  position: Vec;
  [k: string]: unknown;
}

export class BlockTemplates {
  constructor(registry: unknown);
  /** The registry the templates are built from. */
  readonly registry: unknown;
  /** Templates built so far (each state id once). */
  readonly built: number;
  /** The state's template: shared by every block of this state, never write into it. */
  template(stateId: number): BlockLike;
  /** A Block of this state at `position` (kept as the block's own Vec3: pass a fresh one; null, as a palette's). */
  at(stateId: number, position: Vec | null): BlockLike;
}

/** One dimension of the store with prismarine-world's sync reads. Inside the reader's enter()/leave() only. */
export class StoreWorld {
  constructor(reader: WorldReader, templates: BlockTemplates, dim: string);
  readonly dim: string;
  stateIdAt(x: number, y: number, z: number): number;
  getBlockStateId(pos: Vec): number | undefined;
  getBlock(pos: Vec): BlockLike | null;
  /** getBlock that keeps `pos` (a fresh Vec3 the caller drops) as the block's position at integer coordinates. */
  blockAtOwned(pos: Vec): BlockLike | null;
  raycast(from: Vec, direction: Vec, range: number, matcher?: ((block: BlockLike, iter: unknown) => boolean) | null): BlockLike | null;
}
