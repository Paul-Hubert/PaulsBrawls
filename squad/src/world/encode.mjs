// A column of the store back into a chunk payload (docs/37 P5): the inverse of decode.mjs, in the same format
// (prismarine-chunk's 1.18+ ChunkColumn.dump, the packet's chunkData), so the writer decodes it like any other.
//
// Why: with world.shared the bots keep no world of their own, so when the writer dies (P1 restarts it over the same
// buffers, and the new one drops every column) the columns the bots hold are re-sent from the store itself, read on the
// main thread while no writer runs (shared-world.ts). A one-state section is written as a single value; any other as
// the global palette (maxBitsPerBlock bits per block, 8 KB): simple, and only a restart pays for it. Biomes are not
// stored, so they are written as biome 0. Plain JS, types in encode.d.mts.

/**
 * `sections`: per section, the one state that fills it (a number, 0 = air) or its 4 096 state ids (a Uint16Array,
 * index (y << 8) | (z << 4) | x, as the store keeps them). `opts`: tables.mjs decoderOptions. Returns the payload.
 */
export function encodeColumn(sections, opts) {
  const bits = opts.maxBitsPerBlock;
  const perLong = Math.floor(64 / bits);
  const longs = Math.ceil(4096 / perLong);
  let size = 0;
  for (const s of sections) size += typeof s === 'number' ? 16 : 16 + longs * 8;
  const out = new Uint8Array(size + 16 * sections.length);
  const dv = new DataView(out.buffer);
  let pos = 0;
  const varint = (v) => {
    v >>>= 0;
    while (v >= 0x80) {
      out[pos++] = (v & 0x7f) | 0x80;
      v >>>= 7;
    }
    out[pos++] = v;
  };
  for (const s of sections) {
    let count = 0;
    if (typeof s === 'number') count = s === 0 ? 0 : 4096;
    else for (let i = 0; i < 4096; i++) if (s[i] !== 0) count++;
    dv.setInt16(pos, count);
    pos += 2;
    if (opts.hasFluidCount) {
      dv.setInt16(pos, 0);
      pos += 2;
    }
    if (typeof s === 'number') {
      out[pos++] = 0;
      varint(s);
      if (!opts.noSizePrefix) varint(0);
    } else {
      out[pos++] = bits;
      if (!opts.noSizePrefix) varint(longs);
      for (let l = 0, i = 0; l < longs; l++) {
        let hi = 0;
        let lo = 0;
        for (let k = 0, off = 0; k < perLong && i < 4096; k++, off += bits, i++) {
          const v = s[i];
          if (off + bits <= 32) lo |= v << off;
          else if (off >= 32) hi |= v << (off - 32);
          else {
            lo |= v << off;
            hi |= v >>> (32 - off);
          }
        }
        dv.setUint32(pos, hi >>> 0);
        dv.setUint32(pos + 4, lo >>> 0);
        pos += 8;
      }
    }
    // Biomes: one value, biome 0.
    out[pos++] = 0;
    varint(0);
    if (!opts.noSizePrefix) varint(0);
  }
  return out.subarray(0, pos);
}
