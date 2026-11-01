// Decoding a chunk column payload (map_chunk's `chunkData`) into block state ids, section by section (docs/37 §2.2).
// The format is the one prismarine-chunk's 1.18+ ChunkColumn.load reads (pc/1.18/ChunkColumn.js, common/
// PaletteChunkSection.js, PaletteContainer.js, BitArrayNoSpan.js), followed exactly so the store agrees with the bots'
// own worlds block for block, without building their palette objects:
//   per section: int16 non-air count [, int16 fluid count (26.1+)], u8 bits per block, then
//     bits 0      a single value (varint) [, varint data length (0) before 1.21.5]
//     bits 1..8   a palette: varint length, varints; [varint long count;] the longs
//     bits > 8    the global palette: [varint long count;] the longs, read with maxBitsPerBlock bits per value
//   then the biomes, the same container with 0 / 1..3 / > 3 bits, skipped.
// Values never span two longs (1.16+); a long is big-endian, its first value in the low bits. Missing longs read as
// index 0 (palette[0] or air), as prismarine's BitArray does.

export const UNIFORM = 0;
export const FULL = 1;

/**
 * Decode `data` (a Uint8Array) into `nSections` sections. For each section i, calls onSection(i, kind, value):
 * kind UNIFORM: every block is `value` (0 = air); kind FULL: `scratch` (a Uint16Array of 4096) holds the 4096 ids,
 * valid until the next call. Throws on a truncated or malformed payload.
 */
export function decodeColumn(data, nSections, opts, scratch, onSection) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const end = data.byteLength;
  let pos = 0;
  const need = (n) => {
    if (pos + n > end) throw new Error(`chunk payload truncated at byte ${pos} (+${n} of ${end})`);
  };
  const u8 = () => {
    need(1);
    return dv.getUint8(pos++);
  };
  const varint = () => {
    let result = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const b = u8();
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
    }
    throw new Error(`varint too big at byte ${pos}`);
  };
  const longCount = (bits) => (opts.noSizePrefix ? Math.ceil(SECTION_VALUES / Math.floor(64 / bits)) : varint());
  for (let i = 0; i < nSections; i++) {
    need(opts.hasFluidCount ? 4 : 2);
    pos += opts.hasFluidCount ? 4 : 2;
    const bits = u8();
    if (bits > 16) throw new Error(`section ${i}: ${bits} bits per block`);
    if (bits === 0) {
      const value = varint();
      if (!opts.noSizePrefix) varint();
      onSection(i, UNIFORM, value);
    } else {
      let palette = null;
      let width = bits;
      if (bits <= 8) {
        const n = varint();
        palette = new Array(n);
        for (let k = 0; k < n; k++) palette[k] = varint();
      } else {
        width = opts.maxBitsPerBlock;
      }
      // prismarine counts the longs of a prefix-less container with the bits it read, and decodes with `width`.
      const longs = longCount(bits);
      need(longs * 8);
      const first = unpack(dv, pos, longs, width, palette, scratch);
      pos += longs * 8;
      if (first >= 0) onSection(i, UNIFORM, first);
      else onSection(i, FULL, 0);
    }
    // Biomes: skipped.
    const bb = u8();
    if (bb === 0) {
      varint();
      if (!opts.noSizePrefix) varint();
    } else {
      if (bb <= 3) {
        const n = varint();
        for (let k = 0; k < n; k++) varint();
      }
      const longs = opts.noSizePrefix ? Math.ceil(64 / Math.floor(64 / bb)) : varint();
      need(longs * 8);
      pos += longs * 8;
    }
  }
  return pos;
}

const SECTION_VALUES = 4096;

/** Unpack 4096 values into `out`. Returns the value when they are all the same (a uniform section), else -1. */
function unpack(dv, at, longs, bits, palette, out) {
  const perLong = Math.floor(64 / bits);
  const mask = (1 << bits) - 1;
  let i = 0;
  let diff = 0;
  for (let l = 0; l < longs && i < SECTION_VALUES; l++) {
    const hi = dv.getUint32(at + l * 8);
    const lo = dv.getUint32(at + l * 8 + 4);
    for (let k = 0, off = 0; k < perLong && i < SECTION_VALUES; k++, off += bits, i++) {
      let v;
      if (off + bits <= 32) v = (lo >>> off) & mask;
      else if (off >= 32) v = (hi >>> (off - 32)) & mask;
      else v = ((lo >>> off) | (hi << (32 - off))) & mask;
      if (palette !== null) v = palette[v] ?? 0;
      out[i] = v;
      diff |= v ^ out[0];
    }
  }
  if (i < SECTION_VALUES) {
    // Missing longs: index 0, as prismarine's BitArray reads them.
    const v = palette !== null ? (palette[0] ?? 0) : 0;
    out.fill(v, i);
    if (i > 0) diff |= v ^ out[0];
  }
  return diff === 0 ? out[0] : -1;
}
