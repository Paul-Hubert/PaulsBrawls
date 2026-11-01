// Types of layout.mjs (the shared world's memory layout).

import type { DecoderOptions, StateTableBuffers, WorldDescriptor } from './reader.mjs';

export const LAYOUT_VERSION: number;
export const SECTION_BLOCKS: number;
export const PAGE_SECTIONS: number;
export const PAGE_SECTION_BYTES: number;
export const MAX_SECTION_PAGES: number;
export const COL_REFS: number;
export const MAX_COLUMN_SECTIONS: number;
export const COL_INTS: number;
export const PAGE_COLUMNS: number;
export const PAGE_COLUMN_BYTES: number;
export const MAX_COLUMN_PAGES: number;
export const MAX_COLUMNS: number;
export const C_STATE: number;
export const C_TAG: number;
export const C_X: number;
export const C_Z: number;
export const C_MINY: number;
export const C_SECTIONS: number;
export const C_VERSION: number;
export const FREE: number;
export const LIVE: number;
export const CACHED: number;
export const INDEX_CAPACITY: number;
export const TOMBSTONE: number;
export const K_EPOCH: number;
export const K_VERSION: number;
export const K_SECTIONS_HWM: number;
export const K_COLUMNS_HWM: number;
export const K_DIMS: number;
export const K_READERS: number;
export const MAX_DIMS: number;
export const DIM_NAME_BYTES: number;
export const DIM_INTS: number;

export function slotOf(tag: number, cx: number, cz: number, mask: number): number;
export function after(e: number, r: number): boolean;
export function allocateWorld(opts: { version: string; maxReaders: number; tables: StateTableBuffers; decoder: DecoderOptions }): WorldDescriptor;
