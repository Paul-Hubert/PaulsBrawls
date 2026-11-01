// Types of reader.mjs: the shared world as any thread reads it (docs/37 §2.1).

/** The per-state tables' buffers (tables.mjs). */
export interface StateTableBuffers {
  count: number;
  flags: SharedArrayBuffer;
  blockId: SharedArrayBuffer;
  shapeOf: SharedArrayBuffer;
  shapeStart: SharedArrayBuffer;
  shapeCount: SharedArrayBuffer;
  boxData: SharedArrayBuffer;
  blockNames: string[];
}

/** How the writer decodes payloads (tables.mjs decoderOptions). */
export interface DecoderOptions {
  maxBitsPerBlock: number;
  noSizePrefix: boolean;
  hasFluidCount: boolean;
}

/**
 * Everything a thread needs to read the store: its SharedArrayBuffers (shared by reference) and this reader's epoch
 * slot. Structured-cloneable: pass it in a worker's workerData. Get one per reader from SharedWorld.descriptor().
 */
export interface WorldDescriptor {
  layout: number;
  version: string;
  maxReaders: number;
  control: SharedArrayBuffer;
  index: SharedArrayBuffer;
  columns: SharedArrayBuffer;
  sections: SharedArrayBuffer;
  dims: SharedArrayBuffer;
  tables: StateTableBuffers;
  decoder: DecoderOptions;
  /** This descriptor's epoch slot, 0 … maxReaders - 1; -1 = none (the writer's own). */
  reader: number;
  /** Which handing-out of that slot this is (SharedWorld.release frees the slot only for the descriptor holding it). */
  readerToken: number;
}

export interface StateTables {
  /** Number of state ids (1.21.1: 26 684). */
  readonly count: number;
  /**
   * Collision boxes of a state, 6 floats each [minX, minY, minZ, maxX, maxY, maxZ], block-local; length 0 = no
   * collision. A view of shared memory, the same object for every state of one shape: never write into it.
   */
  boxes(stateId: number): Float32Array;
  /** Loops without a view: the boxes of `stateId` are boxData[boxStart … boxStart + 6 × boxCount). */
  boxStart(stateId: number): number;
  boxCount(stateId: number): number;
  readonly boxData: Float32Array;
  /** The flag byte: F_EMPTY | F_SOLID | F_LIQUID | F_CLIMBABLE | F_WATER | F_LAVA | F_WATERLOGGED | F_BB_BLOCK. */
  flags(stateId: number): number;
  /** No collision box in this state (per state: an open fence gate, a one-layer snow layer). */
  isEmpty(stateId: number): boolean;
  /** Water or lava, any level. */
  isLiquid(stateId: number): boolean;
  /** In 1.21.1's #minecraft:climbable tag: ladder, vine, scaffolding, weeping/twisting/cave vines. */
  isClimbable(stateId: number): boolean;
  /** Exactly the full cube (one box 0,0,0 → 1,1,1). */
  isSolid(stateId: number): boolean;
  /** Water as prismarine-physics swims in it: water, bubble column, seagrass, kelp, or waterlogged. */
  isWater(stateId: number): boolean;
  /** The block's name ('' for an id out of range). */
  name(stateId: number): string;
  /** The block's id (-1 for an id out of range). */
  blockId(stateId: number): number;
}

export interface WorldReader {
  /** State id at a block position, or -1 when no LIVE column holds it (unknown, not loaded, or cached-stale). Inside a live column, above or below the world it is 0 (air). */
  stateId(dim: string, x: number, y: number, z: number): number;
  /** stateId with the dimension's index (dimIndex): no name lookup. */
  stateIdIn(dimIndex: number, x: number, y: number, z: number): number;
  hasColumn(dim: string, chunkX: number, chunkZ: number): boolean;
  /** A live column's change counter (every block change and re-decode moves it), or -1. */
  columnVersion(dim: string, chunkX: number, chunkZ: number): number;
  /** { minY, height } of a dimension the store has seen, or null. Any time, no bracket needed. */
  bounds(dim: string): { readonly minY: number; readonly height: number } | null;
  /** The dimension's index for stateIdIn, -1 while unknown. Any time. */
  dimIndex(dim: string): number;
  /** The store's change counter: it moves after every writer batch that changed anything. Any time. */
  version(): number;
  /** Bracket every batch of reads (epoch-based reclamation). Re-entrant calls are an error; so is a read outside. */
  enter(): void;
  leave(): void;
  readonly states: StateTables;
}

export function openWorld(descriptor: WorldDescriptor): WorldReader;

export const F_EMPTY: number;
export const F_SOLID: number;
export const F_LIQUID: number;
export const F_CLIMBABLE: number;
export const F_WATER: number;
export const F_LAVA: number;
export const F_WATERLOGGED: number;
export const F_BB_BLOCK: number;
