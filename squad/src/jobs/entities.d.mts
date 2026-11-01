// Types of entities.mjs (the entity snapshot's shared-memory protocol), for TypeScript callers.

export declare const COL: Readonly<{
  ID: 0; TYPE: 1; KIND: 2; X: 3; Y: 4; Z: 5; VX: 6; VY: 7; VZ: 8; WIDTH: 9; HEIGHT: 10; TEAM: 11;
}>;
export declare const STRIDE: 12;
export declare const HEADER: Readonly<{ EPOCH: 0; TICK: 1; COUNT: 2; WRITTEN_AT: 3 }>;
export declare const HEADER_LENGTH: 4;
export declare const BUFFERS: 2;
export declare const KINDS: readonly string[];

/** mineflayer's entity.type string → its KINDS index (0 = other / unknown). */
export declare function kindCode(type: string | undefined): number;

/** The snapshot's shared memory (structured-cloneable: the SharedArrayBuffers are shared, not copied). */
export interface EntityHandles {
  control: SharedArrayBuffer;
  buffers: SharedArrayBuffer[];
  capacity: number;
  readers: number;
}

/** One entity, as the snapshot holds it. Positions in blocks, velocity in blocks per tick. */
export interface EntityRow {
  /** The server's entity id (the same for every bot). */
  id: number;
  /** The registry's entity type id (mineflayer's `entity.entityType`), -1 when unknown. */
  type: number;
  /** {@link KINDS} index of mineflayer's `entity.type` (1 = player, 2 = hostile…). */
  kind: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  width: number;
  height: number;
  /** The owner group (teams.ts): the same non-zero number for friends, 0 for anyone else. */
  team: number;
}

export interface EntityReader {
  /** Take the published snapshot for a batch (workers: done for you around every batch). */
  pin(): void;
  unpin(): void;
  readonly count: number;
  /** The dispatcher tick it was written at (-1: none yet). */
  readonly tick: number;
  /** Its publish number (0: none yet). */
  readonly epoch: number;
  /** When it was written, ms since the Unix epoch. */
  readonly writtenAt: number;
  /** The raw rows for hot loops: `data[HEADER_LENGTH + i * STRIDE + COL.X]`; null when not pinned or empty. */
  readonly data: Float64Array | null;
  get(id: number): EntityRow | null;
  /** Every row in id order; return false to stop. Each row is a new object. */
  each(fn: (row: EntityRow) => void | boolean): void;
}

export declare function createEntityBuffers(capacity: number, readers: number): EntityHandles;
export declare function freeBuffer(handles: EntityHandles): number;
export declare function publishBuffer(handles: EntityHandles, b: number): void;
export declare function releaseReader(handles: EntityHandles, readerIndex: number): void;
export declare function openEntities(handles: EntityHandles, readerIndex: number): EntityReader;
