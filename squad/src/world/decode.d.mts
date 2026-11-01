// Types of decode.mjs (chunk payloads into block state ids).

import type { DecoderOptions } from './reader.mjs';

export const UNIFORM: number;
export const FULL: number;

export function decodeColumn(
  data: Uint8Array,
  nSections: number,
  opts: DecoderOptions,
  scratch: Uint16Array,
  onSection: (i: number, kind: number, value: number) => void,
): number;
