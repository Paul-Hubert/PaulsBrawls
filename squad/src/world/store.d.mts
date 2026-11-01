// Types of store.mjs (the writer's side; tests drive it directly).

import type { WorldDescriptor } from './reader.mjs';

export interface LoadResult {
  /** The column is LIVE with this payload's content now. */
  live: boolean;
  /** It was decoded (else: the same clean payload, published as is, or refused). */
  decoded: boolean;
  /** The decode time, ms. */
  ms: number;
  /** It was LIVE before this load. */
  wasLive: boolean;
  error?: string;
}

export interface StoreStats {
  columnsLive: number;
  columnsCached: number;
  /** Sections in use (all-air and one-state sections take none). */
  sections: number;
  /** Sections ever handed out (the high-water mark). */
  sectionCapacity: number;
  retiredBatches: number;
  indexUsed: number;
  tombstones: number;
  decoded: number;
  skipped: number;
  failed: number;
  rejected: number;
  evicted: number;
}

export class WorldStore {
  constructor(descriptor: WorldDescriptor, opts: { cacheSeconds: number; cacheColumns: number; reset?: boolean; now?: () => number });
  load(dim: string, x: number, z: number, minY: number, height: number, bytes: Uint8Array): LoadResult;
  release(dim: string, x: number, z: number): boolean;
  set(dim: string, x: number, y: number, z: number, stateId: number): void;
  expire(now?: number): number;
  endBatch(): void;
  reclaim(): number;
  reset(): void;
  stats(): StoreStats;
  /** Free lists, for the tests of reuse. */
  readonly freeSections: number[];
  readonly freeColumns: number[];
}
