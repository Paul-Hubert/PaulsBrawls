// Protocol hardening (docs/29 §16): a server packet mineflayer cannot decode must cost that one packet, never the bot.
//
// Found on the production server: mineflayer's 1.21.1 data cannot decode some items (Polymer items from a mod, and
// an armor-trim item in a vanilla recipe). When the error is not a "partial read", protodef's FullPacketParser fails
// its stream, and from then on the bot hears nothing while staying connected: empty inventory, no block updates, no
// entities. Two layers:
//   1. RECIPES_AS_BYTES: the login `declare_recipes` packet is read as raw bytes. Mineflayer never uses it (recipes
//      come from minecraft-data), and it is where modded and trim items show up first.
//   2. keepDecodersAlive(): FullPacketParser drops an undecodable packet and goes on (reported through `onSkip`,
//      without the stack traces protodef prints to stdout).
// The deaf-bot watchdog in pool.ts is the last net.

import protodef from 'protodef';

/** minecraft-protocol `customPackets`, keyed by major version ('1.21' for 1.21.1). */
export const RECIPES_AS_BYTES = {
  '1.21': {
    play: { toClient: { types: { packet_declare_recipes: ['container', [{ name: 'raw', type: 'restBuffer' }]] } } },
  },
} as const;

/** The six light fields of 1.21.1's map_chunk and update_light, as one raw buffer (lodash.merge merges arrays by index). */
const LIGHT_AS_BYTES = [
  { name: 'light', type: 'restBuffer' },
  { name: 'light1', type: 'void' },
  { name: 'light2', type: 'void' },
  { name: 'light3', type: 'void' },
  { name: 'light4', type: 'void' },
  { name: 'light5', type: 'void' },
] as const;

/**
 * world.shared (docs/37 P5): RECIPES_AS_BYTES, and the light of map_chunk and update_light read as raw bytes. With the
 * shared world nothing reads light (bot-world.ts), and protodef decodes each of a column's ~52 light arrays byte by
 * byte into JS arrays: 0.4 ms per map_chunk on the main thread, per bot, as much as the rest of a login's chunk work
 * (docs/36 §6). As bytes it is a slice (1 µs). The fields before the light are minecraft-data's
 * (tests/shared-bots.test.ts checks them). Only for shared bots: mineflayer's own blocks plugin reads the light.
 *
 * minecraft-protocol keeps ONE compiled protocol per state, direction and version (its cache ignores customPackets)
 * and merges customPackets into minecraft-data's own object: every bot of a process must be given the same set, as the
 * pool does (world.shared is process-wide).
 */
export const SHARED_WORLD_PACKETS = {
  '1.21': {
    play: {
      toClient: {
        types: {
          ...RECIPES_AS_BYTES['1.21'].play.toClient.types,
          packet_map_chunk: [
            'container',
            [
              { name: 'x', type: 'i32' },
              { name: 'z', type: 'i32' },
              { name: 'heightmaps', type: 'anonymousNbt' },
              { name: 'chunkData', type: ['buffer', { countType: 'varint' }] },
              { name: 'blockEntities', type: ['array', { countType: 'varint', type: 'chunkBlockEntity' }] },
              ...LIGHT_AS_BYTES,
            ],
          ],
          packet_update_light: ['container', [{ name: 'chunkX', type: 'varint' }, { name: 'chunkZ', type: 'varint' }, ...LIGHT_AS_BYTES]],
        },
      },
    },
  },
} as const;

export interface SkippedPacket {
  partial: boolean;
  message: string;
  bytes: number;
}

type Transform = (this: ParserLike, chunk: Buffer, enc: BufferEncoding, cb: (err?: Error | null) => void) => void;
interface ParserLike {
  parsePacketBuffer(buffer: Buffer): { data: unknown; metadata: { size: number } };
  push(chunk: unknown): boolean;
}

let installed = false;
let reporter: (s: SkippedPacket) => void = () => undefined;

/**
 * Replace protodef's FullPacketParser._transform (one shared module instance serves every bot of the process): a
 * packet that throws is skipped and reported, partial or not; the stream is never failed. Idempotent; the latest
 * `onSkip` wins.
 */
export function keepDecodersAlive(onSkip: (s: SkippedPacket) => void): void {
  reporter = onSkip;
  if (installed) return;
  installed = true;
  const proto = (protodef as unknown as { FullPacketParser: { prototype: { _transform: Transform } } }).FullPacketParser.prototype;
  proto._transform = function (this: ParserLike, chunk, _enc, cb) {
    let packet: { data: unknown; metadata: { size: number } };
    try {
      packet = this.parsePacketBuffer(chunk);
    } catch (e) {
      const err = e as Error & { partialReadError?: boolean };
      try {
        reporter({ partial: !!err.partialReadError, message: String(err.message).split('\n')[0] ?? '', bytes: chunk.length });
      } catch {
        /* a reporter must not break decoding */
      }
      return cb();
    }
    this.push(packet);
    cb();
  };
}
