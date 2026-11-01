// Types of tables.mjs (the per-state tables, built from a prismarine-registry).

import type { DecoderOptions, StateTableBuffers } from './reader.mjs';

export const F_EMPTY: number;
export const F_SOLID: number;
export const F_LIQUID: number;
export const F_CLIMBABLE: number;
export const F_WATER: number;
export const F_LAVA: number;
export const F_WATERLOGGED: number;
export const F_BB_BLOCK: number;

/** `registry` is a prismarine-registry (loosely typed: blocksArray, blockCollisionShapes, version). */
export function buildStateTables(registry: unknown): StateTableBuffers;
export function decoderOptions(registry: unknown, tables: StateTableBuffers): DecoderOptions;
