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
