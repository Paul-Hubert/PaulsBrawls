// Following a bot's world packets (docs/37 §2.2): the same packets and the same rules as the pathfinding workers'
// mirror (bots/pathworkers/client.ts attach, which P4 retires), so the shared world sees exactly what mineflayer's
// blocks plugin applies to the bot's own world:
//   • login, and a respawn into another world (1.20.5+: worldState; a respawn into the same dimension, or into the
//     same world with copyMetadata, keeps the columns, as mineflayer does): a new dimension drops every column;
//   • map_chunk (the raw chunkData), unload_chunk;
//   • block_change, multi_block_change (1.20+: one long per record, stateId << 12 | x << 8 | z << 4 | y), explosion
//     (its affected blocks become air);
//   • the bot's 'end'.
// The sink decides what to keep. A sink that throws costs one warning, never the bot.

import { logger } from '../logger';

/** The parts of a mineflayer bot followed here. Loose on purpose: fakes drive it in tests. */
export interface FollowedBot {
  _client?: { on?: (ev: string, fn: (packet: never) => void) => unknown };
  on?: (ev: string, fn: (...a: never[]) => void) => unknown;
}

export interface WorldPacketSink {
  /** The bot entered a world (login, or a respawn into another dimension): it holds no column any more. */
  dimension(name: string): void;
  chunk(x: number, z: number, data: Buffer): void;
  unload(x: number, z: number): void;
  block(x: number, y: number, z: number, stateId: number): void;
  end(): void;
}

/** Listen to the bot's packets. Returns false when the bot has no packet stream (`_client`). */
export function followWorldPackets(bot: FollowedBot, sink: WorldPacketSink, label: string, alive: () => boolean = () => true): boolean {
  const client = bot._client;
  if (typeof client?.on !== 'function') return false;
  let dim: string | null = null;
  let dimId: unknown;
  const on = (ev: string, fn: (p: Record<string, unknown>) => void): void => {
    client.on!(ev, ((p: Record<string, unknown>) => {
      if (!alive()) return;
      try {
        fn(p);
      } catch (e) {
        logger.warn(label, `${ev} failed: ${(e as Error).message}`);
      }
    }) as never);
  };
  const enter = (name: string, id: unknown): void => {
    dim = name;
    dimId = id;
    sink.dimension(name);
  };
  on('login', (p) => {
    const ws = (p.worldState ?? p) as Record<string, unknown>;
    enter(String(ws.name ?? ws.worldName ?? ws.dimension), ws.dimension);
  });
  on('respawn', (p) => {
    const ws = (p.worldState ?? p) as Record<string, unknown>;
    const name = String(ws.name ?? ws.worldName ?? ws.dimension);
    if (dimId === ws.dimension) return;
    if (dim === name && Boolean(p.copyMetadata)) return;
    enter(name, ws.dimension);
  });
  on('map_chunk', (p) => {
    if (p.chunkData) sink.chunk(p.x as number, p.z as number, p.chunkData as Buffer);
  });
  on('unload_chunk', (p) => sink.unload(p.chunkX as number, p.chunkZ as number));
  on('block_change', (p) => {
    const l = p.location as { x: number; y: number; z: number };
    sink.block(l.x, l.y, l.z, p.type as number);
  });
  on('multi_block_change', (p) => {
    const c = p.chunkCoordinates as { x: number; y: number; z: number };
    for (const r of p.records as number[]) {
      sink.block(c.x * 16 + ((r >> 8) & 15), c.y * 16 + (r & 15), c.z * 16 + ((r >> 4) & 15), r >> 12);
    }
  });
  on('explosion', (p) => {
    const offsets = p.affectedBlockOffsets as Array<{ x: number; y: number; z: number }> | undefined;
    if (!offsets) return;
    for (const o of offsets) {
      sink.block(Math.floor((p.x as number) + o.x), Math.floor((p.y as number) + o.y), Math.floor((p.z as number) + o.z), 0);
    }
  });
  bot.on?.('end', () => {
    try {
      sink.end();
    } catch (e) {
      logger.warn(label, `end failed: ${(e as Error).message}`);
    }
  });
  return true;
}
