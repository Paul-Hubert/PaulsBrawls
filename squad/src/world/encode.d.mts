// Types of encode.mjs: a store column back into a chunk payload (the inverse of decode.mjs).

import type { DecoderOptions } from './reader.mjs';

/** Per section the one state filling it (0 = air) or its 4 096 state ids; returns the chunkData bytes. */
export function encodeColumn(sections: Array<number | Uint16Array>, opts: DecoderOptions): Uint8Array;
